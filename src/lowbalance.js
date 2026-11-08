'use strict';
// Low provider-balance alert (since 2026-11-08).
// After each accepted SMS (in the background, the API reply is not delayed) the gateway asks the provider
// for the credit of OUR account at that provider, if the driver can tell it (optional driver.balance(ctx)
// returning { amount, remaining_sms? }). If amount < threshold it sends ONE alert SMS (text) to the alert
// number through the same provider, then at most once every N hours while it stays low. When the balance is
// above the threshold again, the next drop alerts at once.
// Panel settings (page "Alerts", table `settings`): alert_phone, alert_threshold (0 = off), alert_repeat_hours.
// Per provider state (also in `settings`): bal_<id> = last known balance (JSON), alert_at_<id> = last alert (ms).
const settings = require('./settings');

const DEFAULT_PHONE = '09031238058';
const inflight = new Set();

async function getConfig() {
  const s = await settings.all();
  return {
    phone: (s.alert_phone ?? DEFAULT_PHONE).trim(),
    threshold: Number(s.alert_threshold ?? 0) || 0,
    repeatHours: Number(s.alert_repeat_hours ?? 24) || 24,
  };
}

async function lastBalance(providerId) {
  try { return JSON.parse((await settings.all())[`bal_${providerId}`] || 'null'); } catch { return null; }
}

const fmt = (n) => Number(n).toLocaleString('en-US');

async function check(provider, driver) {
  if (typeof driver.balance !== 'function' || driver.type !== 'text') return null;
  const cfg = await getConfig();
  if (cfg.threshold <= 0 || !cfg.phone) return null;
  if (inflight.has(provider.id)) return null; // one check at a time per provider
  inflight.add(provider.id);
  try {
    const ctx = { settings: provider.settings, provider };
    const b = await driver.balance(ctx);
    const amount = Number(b.amount);
    await settings.set(`bal_${provider.id}`, JSON.stringify({ amount, remaining_sms: b.remaining_sms ?? null, at: Date.now() }));
    const s = await settings.all();
    const lastAlert = Number(s[`alert_at_${provider.id}`] || 0);
    if (amount >= cfg.threshold) {
      if (lastAlert) await settings.set(`alert_at_${provider.id}`, 0);
      return { amount, alerted: false };
    }
    if (lastAlert && Date.now() - lastAlert < cfg.repeatHours * 3600 * 1000) return { amount, alerted: false };
    await settings.set(`alert_at_${provider.id}`, Date.now()); // set first: parallel checks must not alert twice
    const text = `هشدار موجودی پیامک: اعتبار «${provider.name}» ${fmt(amount)}`
      + `${b.remaining_sms != null ? ` (${fmt(b.remaining_sms)} پیامک)` : ''} است و کمتر از حد ${fmt(cfg.threshold)} شده. لطفا شارژ کنید.`;
    try {
      await driver.send(ctx, { to: cfg.phone, text, template: null, params: null, paramList: [], parts: 1 });
      console.log(`low balance alert sent for ${provider.slug}: ${amount} < ${cfg.threshold}`);
    } catch (e) {
      await settings.set(`alert_at_${provider.id}`, 0); // not sent: try again on the next SMS
      console.error(`low balance alert for ${provider.slug} failed: ${e.message}`);
    }
    return { amount, alerted: true };
  } catch (e) {
    console.error(`balance check for ${provider.slug} failed: ${e.message}`);
    return null;
  } finally {
    inflight.delete(provider.id);
  }
}

module.exports = { DEFAULT_PHONE, getConfig, lastBalance, check };
