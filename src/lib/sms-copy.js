function getDurationOfferDisplayName(targetDurationMinutes) {
  const target = Number(targetDurationMinutes || 0);
  if (target === 50) return "50-Min Esthetician's Choice Facial";
  if (target === 90) return '90-Min Premier Contour';
  if (Number.isFinite(target) && target > 0) return `${target}-Minute facial`;
  return 'extended facial';
}

export {
  getDurationOfferDisplayName,
};
