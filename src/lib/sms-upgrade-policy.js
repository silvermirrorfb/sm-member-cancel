const DEFAULT_SUPPORT_PHONE = '(888) 677-0055';
const SMS_UPGRADE_PENDING_REASON = 'sms_upgrade_feature_pending';

function normalizeSmsUpgradeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'live' ? 'live' : 'pending';
}

function getSupportPhone() {
  return String(process.env.SUPPORT_PHONE || DEFAULT_SUPPORT_PHONE).trim() || DEFAULT_SUPPORT_PHONE;
}

function getSmsUpgradeStatus() {
  return normalizeSmsUpgradeStatus(process.env.SMS_UPGRADE_STATUS || process.env.SMS_UPGRADE_MODE);
}

function isSmsUpgradeLive() {
  return getSmsUpgradeStatus() === 'live';
}

function buildSmsUpgradePendingReply() {
  return `Our upgrade-by-text feature is still pending while we finish setup. Please call ${getSupportPhone()} and our team can help.`;
}

export {
  SMS_UPGRADE_PENDING_REASON,
  buildSmsUpgradePendingReply,
  getSmsUpgradeStatus,
  isSmsUpgradeLive,
};
