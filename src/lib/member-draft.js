// src/lib/member-draft.js
//
// Generates a pre-filled "draft email to member" from a session summary.
// This draft is embedded into the memberships@ alert so Fernanda can
// copy/paste (or reply-forward) instead of manually filling placeholders.
//
// Matches cancellation reason + outcome + accepted offer to the right
// template and fills in placeholders from the summary.

const SIGNATURE = `\nWarmly,\nFernanda\nMemberships Team\nSilver Mirror\nmemberships@silvermirror.com\n(888) 677-0055`;

const LOCATION_LEADS = {
  'upper east side': { lead: 'PJ', manager: 'PJ' },
  'flatiron': { lead: 'Vanessa', manager: 'Vanessa' },
  'bryant park': { lead: 'Karen', manager: 'Karen' },
  'manhattan west': { lead: 'Missy', manager: 'Missy' },
  'upper west side': { lead: 'Brianne', manager: 'Brianne' },
  'dupont circle': { lead: 'Andrea / Kamlilah', manager: 'Andrea / Kamlilah' },
  'navy yard': { lead: 'Nique', manager: 'Nique' },
  'penn quarter': { lead: 'Chevisa', manager: 'Chevisa' },
  'brickell': { lead: 'Carla / Nidia', manager: 'Carla / Nidia' },
  'coral gables': { lead: 'Evey', manager: 'Evey' },
};

function getLeadInfo(location) {
  const loc = String(location || '').toLowerCase().trim();
  for (const [key, info] of Object.entries(LOCATION_LEADS)) {
    if (loc.includes(key)) return { location: key.replace(/\b\w/g, c => c.toUpperCase()), ...info };
  }
  return { location: location || 'your home location', lead: 'our lead esthetician', manager: 'the location manager' };
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'there';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function formatTenure(months) {
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0) return 'Less than 1 month';
  if (n < 12) return `${n} month${n === 1 ? '' : 's'}`;
  const years = Math.floor(n / 12);
  const rem = n % 12;
  if (rem === 0) return `${years} year${years === 1 ? '' : 's'}`;
  return `${years} year${years === 1 ? '' : 's'}, ${rem} month${rem === 1 ? '' : 's'}`;
}

// --- TEMPLATE MATCHER -------------------------------------------------------
//
// Picks a template based on (reason_primary, outcome, offer_accepted).
// Returns { id, subject, body } with placeholders already filled in.

function pickTemplate(summary) {
  const reason = String(summary.reason_primary || '').toLowerCase();
  const outcome = String(summary.outcome || '').toUpperCase();
  const offerAccepted = String(summary.offer_accepted || '').toLowerCase();

  const isRetained = outcome === 'RETAINED';
  const isCancelled = outcome === 'CANCELLED';
  const isPause = /pause/.test(offerAccepted);
  const isDowngrade = /downgrade/.test(offerAccepted);
  const isBimonthly = /bi.?monthly|bimonthly/.test(offerAccepted);
  const isTransfer = /transfer|location/.test(offerAccepted);
  const isCallback = /manager|callback/.test(offerAccepted);
  const isFreeAddon = /free.*add.?on|add.?on|peel|hydra/.test(offerAccepted);
  const isLead = /lead|consultation/.test(offerAccepted);
  const isCredit = /credit|convert/.test(offerAccepted);
  const isAIScan = /skin.?scan|ai/.test(offerAccepted);

  // Reason matching (order matters — more specific first)
  if (/\breaction\b|\ballergy\b|\bbreakout\b|\birritation\b/.test(reason)) {
    return isCallback ? tmplReactionCallback(summary) : tmplReactionFreeCalming(summary);
  }
  if (/medical|health|surgery|pregnan/.test(reason)) {
    return isPause ? tmplMedicalPause(summary) : tmplMedicalExtended(summary);
  }
  if (/lost.?job|unemploy|laid.?off|job loss/.test(reason)) {
    return isPause ? tmplLostJobPause(summary) : tmplLostJobCancel(summary);
  }
  if (/travel|vacation|trip/.test(reason)) {
    return tmplTravelPause(summary);
  }
  if (/reloc|moving|moved/.test(reason)) {
    if (isTransfer) return tmplRelocationTransfer(summary);
    return tmplRelocationCancel(summary);
  }
  if (/dermatolog/.test(reason)) {
    return isLead ? tmplDermConsult(summary) : tmplDermCancel(summary);
  }
  if (/new.?provider|another.?spa|different.?spa/.test(reason)) {
    return isLead ? tmplNewProviderConsult(summary) : tmplNewProviderCancel(summary);
  }
  if (/forgot|didn.?t use|haven.?t used|not using/.test(reason)) {
    return isPause ? tmplForgotPause(summary) : tmplForgotDowngrade(summary);
  }
  if (/sold to|pushy|sales|pressur/.test(reason)) {
    return isCallback ? tmplSoldToCallback(summary) : tmplSoldToFreeAddon(summary);
  }
  if (/repetitive|same.?thing|same.?treatment|same.?facial|boring/.test(reason)) {
    return isFreeAddon ? tmplRepetitiveFreeAddon(summary) : tmplRepetitiveLead(summary);
  }
  if (/turnover|left|departed|quit/.test(reason)) {
    return isLead ? tmplTurnoverLead(summary) : tmplTurnoverFreeFacial(summary);
  }
  if (/no.?result|not.?working|not.?seeing/.test(reason)) {
    return isFreeAddon ? tmplNoResultsFreeAddon(summary) : tmplNoResultsLead(summary);
  }
  if (/\bno\s*(personalized\s*)?plan\b|treatment\s*plan|roadmap|custom\s*plan/.test(reason)) {
    return isAIScan ? tmplNoPlanAI(summary) : tmplNoPlanFreeFacial(summary);
  }
  if (/front.?desk|check.?in|reception/.test(reason)) {
    return isCallback ? tmplFrontDeskCallback(summary) : tmplFrontDeskFreeAddon(summary);
  }
  if (/inexperienc|new esth|junior/.test(reason)) {
    return isAIScan ? tmplInexpAI(summary) : tmplInexpLead(summary);
  }
  if (/voucher|credit.?build|unused.?credit/.test(reason)) {
    return isCredit ? tmplVoucherCredit(summary) : tmplVoucherPause(summary);
  }
  if (/cost|expensive|afford|budget|pric/.test(reason)) {
    if (isDowngrade) return tmplCostDowngrade(summary);
    if (isBimonthly) return tmplCostBimonthly(summary);
    return tmplCostPause(summary);
  }
  if (/inconsist|varies|different.?each/.test(reason)) {
    return isCallback ? tmplInconsistentCallback(summary) : tmplInconsistentLead(summary);
  }
  if (/parking|transit|commute|far/.test(reason)) {
    const loc = String(summary.location || '').toLowerCase();
    if (/brickell/.test(loc)) return tmplParkingBrickell(summary);
    if (isPause || isRetained) return tmplParkingTransit(summary);
    return tmplLocationCancel(summary);
  }
  if (/value|worth|not.?worth/.test(reason)) {
    return isAIScan ? tmplLackValueAI(summary) : tmplLackValueFreeHydra(summary);
  }

  // Fallback
  return tmplGenericCancelled(summary);
}

// --- TEMPLATES --------------------------------------------------------------

function tmplTravelPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '01-travel-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

Thanks so much for letting us know about your upcoming travel. I've gone ahead and paused your ${s.membership_tier}-minute membership, effective today.

Here's what that means for you:
• Your billing is paused — no charges during the pause period
• Your locked-in member rate of $${s.monthly_rate}/month stays locked for when you come back
• Any existing credits (${s.unused_credits || 0}) in your account are preserved
• A 3-billing-cycle commitment applies when your membership resumes

If your travel plans shift and you need to extend the pause, just reply to this email and I'll take care of it.

Safe travels, and we can't wait to see you when you're back!${SIGNATURE}`,
  };
}

function tmplRelocationTransfer(s) {
  const fn = firstName(s.client_name);
  return {
    id: '03-relocation-transfer',
    subject: 'Your Silver Mirror location transfer is confirmed',
    body: `Hi ${fn},

Congrats on the move! I've transferred your ${s.membership_tier}-minute membership to your new home location.

Here's what stays the same:
• Your locked-in rate of $${s.monthly_rate}/month
• Your existing credits (${s.unused_credits || 0}) carry forward
• Your milestone perks and loyalty points
• Everything you'd expect as a member, just at a new home

If there's anything you want to coordinate before your first visit at the new location — a particular esthetician, a specific service — just let me know and I'll get it set up.

Welcome home to your new Silver Mirror!${SIGNATURE}`,
  };
}

function tmplRelocationCancel(s) {
  const fn = firstName(s.client_name);
  return {
    id: '02-relocation-cancel',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

Thanks for letting us know about your move. I've processed your cancellation — your ${s.membership_tier}-minute membership will end after your next billing cycle, and no further charges will be made after that.

A few things to know:
• Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge date
• If you'd like to redeem any loyalty points before they expire, just reply and I can help
• If you ever return to a city with a Silver Mirror location, we'd love to welcome you back

Wishing you the best in the next chapter!${SIGNATURE}`,
  };
}

function tmplReactionCallback(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '20-reaction-callback',
    subject: 'A manager from Silver Mirror will reach out within 24 hours',
    body: `Hi ${fn},

I'm so sorry you experienced a reaction. Your comfort and safety are the most important thing, and I want to make sure the right people on our team hear from you directly.

Here's what happens next:
• ${loc.manager}, the ${loc.location} manager, will call you at ${s.phone || 'your number on file'} within the next 24 hours — sooner if possible
• Our lead esthetician and clinical team have been notified
• If the reaction is ongoing or severe, please seek medical attention and let us know so we can support your care
• Your membership has been paused with no charges pending until we've had a chance to talk

No 3-billing-cycle commitment applies here — this is about making sure you're okay, first and always.

If you have photos of the reaction, please forward them to me so the clinical team can see what happened. This helps us understand what triggered it and make sure we protect you and other members going forward.

Please take care of yourself. We'll be in touch very soon.${SIGNATURE}`,
  };
}

function tmplReactionFreeCalming(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '21-reaction-free-calming',
    subject: 'A complimentary calming facial with our lead esthetician',
    body: `Hi ${fn},

I'm so sorry you had a reaction. I want to make this right.

I've booked you a complimentary calming facial with ${loc.lead}, our lead esthetician at ${loc.location}. She'll design the treatment specifically for your skin, take a close look at what triggered the reaction, and build a plan to make sure it doesn't happen again.

Your membership is paused in the meantime — no charges, no 3-cycle commitment, no pressure. If you decide after the calming facial that you'd rather not continue, we'll cancel with zero questions.

Please reply with a few dates and times that work in the next week or two, and I'll confirm the booking.${SIGNATURE}`,
  };
}

function tmplMedicalPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '33-medical-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

I'm sorry to hear you're dealing with something health-related. I've paused your ${s.membership_tier}-minute membership, effective today.

Here's how it works:
• No charges during your pause
• Your rate of $${s.monthly_rate}/month stays locked
• Your existing credits (${s.unused_credits || 0}) are preserved
• No 3-billing-cycle commitment applies here — your health comes first

When you're ready to come back, just reply to this email and I'll reactivate. If you need more time, we can extend the pause — no pressure either way.

Wishing you a speedy recovery.${SIGNATURE}`,
  };
}

function tmplMedicalExtended(s) {
  const fn = firstName(s.client_name);
  return {
    id: '34-medical-extended',
    subject: 'Your Silver Mirror membership pause is extended',
    body: `Hi ${fn},

I've extended your pause with no end date. Your membership is on hold until you're ready to reactivate, and no charges will be made in the meantime.

When you feel ready to come back — whether that's in a month or in a year — just reply to this email and I'll take care of it.

In the meantime: your locked-in rate of $${s.monthly_rate}/month stays locked, your existing credits (${s.unused_credits || 0}) are preserved, and there's no 3-billing-cycle commitment when you resume.

Take all the time you need. We're here when you're ready.${SIGNATURE}`,
  };
}

function tmplLostJobPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '31-lost-job-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

I'm sorry you're going through this. I've paused your ${s.membership_tier}-minute membership, effective today. No charges while you're paused.

A few things:
• Your rate of $${s.monthly_rate}/month stays locked
• Your existing credits (${s.unused_credits || 0}) are preserved
• No 3-billing-cycle commitment applies here

If you need to extend the pause as you get back on your feet, just reply and I'll take care of it — no questions asked.

Wishing you the best through this transition.${SIGNATURE}`,
  };
}

function tmplLostJobCancel(s) {
  const fn = firstName(s.client_name);
  return {
    id: '32-lost-job-cancel',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

I've processed your cancellation — your ${s.membership_tier}-minute membership will end after your next billing cycle, and no further charges will be made.

A few things to know:
• Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge
• Any loyalty points in your account can still be redeemed — just reply if you want help
• When you're ready to come back, we'd love to have you

Wishing you the best through this transition.${SIGNATURE}`,
  };
}

function tmplCostDowngrade(s) {
  const fn = firstName(s.client_name);
  const newTier = s.membership_tier === 50 ? 30 : s.membership_tier === 90 ? 50 : 30;
  return {
    id: '28-cost-downgrade',
    subject: 'Your Silver Mirror membership change is confirmed',
    body: `Hi ${fn},

I've moved you down to our ${newTier}-minute membership, effective your next billing cycle. You keep everything important about being a member, at a lower monthly cost.

Here's what stays the same:
• All member perks (20% off Silver Mirror products, 10% off other retail brands, loyalty points, milestone rewards)
• Your existing credits (${s.unused_credits || 0}) carry forward
• Everything about your account, just on a smaller tier

A 3-billing-cycle commitment applies to this change.

Many members tell us the 30-minute facial is actually the right fit for ongoing maintenance once their skin is in good shape. If you want help deciding which add-ons to focus on to make the most of it, just reply.${SIGNATURE}`,
  };
}

function tmplCostBimonthly(s) {
  const fn = firstName(s.client_name);
  return {
    id: '30-cost-bimonthly',
    subject: 'Your Silver Mirror bi-monthly billing is confirmed',
    body: `Hi ${fn},

I've switched you to bi-monthly billing, effective your next billing cycle. Same rate of $${s.monthly_rate}, same perks, just billed every other month instead.

Here's how it works:
• You're billed $${s.monthly_rate} every other month instead of monthly
• All member perks stay exactly the same
• Your credits accumulate the same way
• A 3-billing-cycle commitment applies

This is a great middle ground if you want to keep your membership active but space out the billing. If it stops feeling right, reply and we can revisit.${SIGNATURE}`,
  };
}

function tmplCostPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '29-cost-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

I've paused your ${s.membership_tier}-minute membership, effective today. No charges during your pause.

While you're paused:
• Your rate of $${s.monthly_rate}/month stays locked
• Your existing credits (${s.unused_credits || 0}) are preserved
• A 3-billing-cycle commitment applies when you resume

Whenever you're ready to come back, just reply and I'll reactivate.${SIGNATURE}`,
  };
}

function tmplForgotPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '08-forgot-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

Totally understand — life gets busy. I've paused your ${s.membership_tier}-minute membership so you can hit reset.

While you're paused:
• No charges until you reactivate
• Your rate of $${s.monthly_rate}/month stays locked
• Your existing credits (${s.unused_credits || 0}) are preserved
• A 3-billing-cycle commitment applies when you resume

When you're ready to come back, reply and I'll reactivate. Want me to send a reminder in a month to check in? Just say the word.${SIGNATURE}`,
  };
}

function tmplForgotDowngrade(s) {
  const fn = firstName(s.client_name);
  const newTier = s.membership_tier === 50 ? 30 : 30;
  return {
    id: '09-forgot-downgrade',
    subject: 'Your Silver Mirror membership change is confirmed',
    body: `Hi ${fn},

I've moved you to our ${newTier}-minute membership, effective your next billing cycle. Lower commitment, easier to keep up with on a busy schedule.

What stays the same: all member perks, your credits (${s.unused_credits || 0}), your loyalty points, everything about your account — just on a smaller tier.

A 3-billing-cycle commitment applies.

If you'd like, I can set a gentle reminder to help you make sure you're using your monthly facial. Just let me know.${SIGNATURE}`,
  };
}

function tmplSoldToCallback(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '10-sold-to-callback',
    subject: 'A manager from Silver Mirror will reach out',
    body: `Hi ${fn},

Thank you for sharing that feedback — and I'm sorry you felt that way. A relaxing facial should be exactly that: relaxing. Not a sales pitch.

${loc.manager}, the ${loc.location} manager, will reach out to you at ${s.phone || 'your number on file'} within the next 24 hours to hear you out and make this right. Your membership is on hold in the meantime.

We take this seriously. Feedback like yours is how we get better.${SIGNATURE}`,
  };
}

function tmplSoldToFreeAddon(s) {
  const fn = firstName(s.client_name);
  return {
    id: '11-sold-to-free-addon',
    subject: 'A complimentary add-on on your next visit',
    body: `Hi ${fn},

I'm sorry you felt pressured during your facial. That's not the experience we want you to have.

I've added a complimentary add-on to your next visit — no strings, nothing to upgrade, just something extra on the house. I've also flagged your feedback for the team so we can do better.

Your membership stays active. If anything comes up before your next facial that I can help with, reply anytime.${SIGNATURE}`,
  };
}

function tmplRepetitiveFreeAddon(s) {
  const fn = firstName(s.client_name);
  return {
    id: '12-repetitive-free-addon',
    subject: 'A complimentary add-on to switch things up',
    body: `Hi ${fn},

Good feedback — facials should evolve with your skin, not feel like the same thing every month.

I've added a complimentary add-on to your next visit so we can mix it up. Your esthetician will pick one that complements what your skin needs right now. If you want to call out a specific concern in advance (dullness, texture, hydration, etc), just reply and I'll make sure they know.${SIGNATURE}`,
  };
}

function tmplRepetitiveLead(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '13-repetitive-lead',
    subject: 'A consultation with our lead esthetician',
    body: `Hi ${fn},

Let's mix things up. I'd love to get you in front of ${loc.lead}, our lead esthetician at ${loc.location}, for a consultation. She can take a fresh look at your skin, map out a new treatment plan, and coordinate with your regular esthetician going forward so each visit builds on the last.

Reply with a few dates that work and I'll book it.${SIGNATURE}`,
  };
}

function tmplTurnoverLead(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '14-turnover-lead',
    subject: `A new esthetician recommendation from ${loc.lead}`,
    body: `Hi ${fn},

I'm sorry your esthetician left. Building a great relationship with someone who knows your skin takes time, and I know starting over isn't fun.

${loc.lead}, our lead esthetician at ${loc.location}, will review your history and recommend the esthetician on our team who best matches your skin profile and the techniques you've loved. I'll send the recommendation in a follow-up email within 48 hours.${SIGNATURE}`,
  };
}

function tmplTurnoverFreeFacial(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '15-turnover-free-facial',
    subject: `A complimentary facial with ${loc.lead}`,
    body: `Hi ${fn},

I'm sorry your esthetician left. Let's get you back in with someone great.

I've booked you a complimentary facial with ${loc.lead}, our lead esthetician at ${loc.location}. She'll get to know your skin, understand what you loved about your previous esthetician, and either take you on herself or match you with the perfect person on our team.

Reply with a few dates that work and I'll confirm.${SIGNATURE}`,
  };
}

function tmplNoResultsFreeAddon(s) {
  const fn = firstName(s.client_name);
  return {
    id: '16-no-results-free-addon',
    subject: 'A complimentary add-on targeted at your skin goals',
    body: `Hi ${fn},

I hear you — if you're not seeing results, something needs to change. Let's push harder.

I've added a complimentary add-on to your next visit aimed at your specific goals. Your esthetician will pick the one with the most impact for what you're trying to achieve. Reply with what you're hoping to see improve and I'll make sure they know.${SIGNATURE}`,
  };
}

function tmplNoResultsLead(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '17-no-results-lead',
    subject: 'A consultation with our lead esthetician',
    body: `Hi ${fn},

If you're not seeing results, let's rethink the plan together. I'd love to get you in with ${loc.lead}, our lead esthetician at ${loc.location}, for a consultation. She'll analyze your skin, review what treatments you've had, and put together a new plan aimed at real visible change.

Reply with a few dates and I'll book it.${SIGNATURE}`,
  };
}

function tmplNoPlanAI(s) {
  const fn = firstName(s.client_name);
  return {
    id: '18-no-plan-ai',
    subject: 'AI skin scans — a personalized roadmap for your skin',
    body: `Hi ${fn},

You deserve a plan, not a one-size-fits-all facial. I've added complimentary AI skin scans to your next visit — they map your skin's current state, identify what to target, and generate a customized treatment roadmap we can build against month over month.

Your esthetician will walk through the results with you and together you'll build a plan that's actually yours.${SIGNATURE}`,
  };
}

function tmplNoPlanFreeFacial(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '19-no-plan-free-facial',
    subject: `A complimentary facial with ${loc.lead} — for a real plan`,
    body: `Hi ${fn},

Let's build you a real plan. I've booked you a complimentary facial with ${loc.lead}, our lead esthetician at ${loc.location}. She'll assess your skin, map out treatment priorities, and hand you a clear roadmap for what to focus on each month.

Reply with a few dates that work and I'll confirm.${SIGNATURE}`,
  };
}

function tmplFrontDeskCallback(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '22-frontdesk-callback',
    subject: 'A manager from Silver Mirror will reach out',
    body: `Hi ${fn},

I'm sorry about the front desk experience. That's not the welcome we want you to have, and I want the right person to hear directly from you.

${loc.manager}, the ${loc.location} manager, will reach out to you at ${s.phone || 'your number on file'} within the next 24 hours.

Your feedback is how we improve. Thank you for taking the time to share it.${SIGNATURE}`,
  };
}

function tmplFrontDeskFreeAddon(s) {
  const fn = firstName(s.client_name);
  return {
    id: '23-frontdesk-free-addon',
    subject: 'A complimentary add-on on your next visit',
    body: `Hi ${fn},

I'm sorry the front desk interaction wasn't great. I've added a complimentary add-on to your next visit and flagged your feedback for the team at your location.

If anything else comes up, reply anytime.${SIGNATURE}`,
  };
}

function tmplInexpAI(s) {
  const fn = firstName(s.client_name);
  return {
    id: '24-inexp-ai',
    subject: 'Complimentary AI skin scans on your next visit',
    body: `Hi ${fn},

Let me help your next facial land better. I've added complimentary AI skin scans to your next visit. They give your esthetician an objective map of your skin — hydration, texture, pigmentation — so they can treat with precision regardless of their level of experience.

See you soon.${SIGNATURE}`,
  };
}

function tmplInexpLead(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '25-inexp-lead',
    subject: 'Booking you with our most experienced team',
    body: `Hi ${fn},

Totally fair. I'll make sure your next facial is with one of our most experienced team members. ${loc.lead}, our lead esthetician at ${loc.location}, will either see you herself or personally match you with a senior esthetician.

Reply with dates that work and I'll confirm.${SIGNATURE}`,
  };
}

function tmplVoucherCredit(s) {
  const fn = firstName(s.client_name);
  return {
    id: '26-voucher-credit',
    subject: 'Your Silver Mirror credits are converted to product credit',
    body: `Hi ${fn},

I've converted your ${s.unused_credits || 0} credits to product credit, which you can use toward Silver Mirror skincare products. This way nothing goes to waste.

Your product credit is good for the next 90 days. Let me know if you'd like recommendations on what to try — happy to help.${SIGNATURE}`,
  };
}

function tmplVoucherPause(s) {
  const fn = firstName(s.client_name);
  return {
    id: '27-voucher-pause',
    subject: 'Your Silver Mirror membership pause is confirmed',
    body: `Hi ${fn},

I've paused your ${s.membership_tier}-minute membership so you can catch up on your existing credits (${s.unused_credits || 0}) before accumulating more.

While paused: no charges, your rate of $${s.monthly_rate}/month stays locked, and a 3-billing-cycle commitment applies when you resume.

Reply when you've used your credits and I'll reactivate. Or let me know if you want help picking which services to book with them.${SIGNATURE}`,
  };
}

function tmplDermConsult(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '04-derm-consult',
    subject: 'A consultation with our lead esthetician',
    body: `Hi ${fn},

Seeing a dermatologist is a great idea for clinical skin concerns. Our facials are designed to work alongside dermatology care — we handle maintenance and support what your derm is doing clinically.

Before you decide on your membership, I'd love to get you a consultation with ${loc.lead}, our lead esthetician at ${loc.location}. She'll review what your derm is addressing and build a facial plan that complements (not competes with) your derm treatment.

Reply with a few dates and I'll book it.${SIGNATURE}`,
  };
}

function tmplDermCancel(s) {
  const fn = firstName(s.client_name);
  return {
    id: '05-derm-cancel',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

I've processed your cancellation. Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge date.

Wishing you the best with your skincare — and if you ever want to add facial maintenance back alongside your derm care, we're here.${SIGNATURE}`,
  };
}

function tmplNewProviderConsult(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '06-new-provider-consult',
    subject: `A consultation with ${loc.lead}`,
    body: `Hi ${fn},

Before you decide, I'd love for you to have a consultation with ${loc.lead}, our lead esthetician at ${loc.location}. She'll take a fresh look at your skin and show you what's possible here — no pressure, just a real conversation.

Reply with a few dates that work and I'll book it.${SIGNATURE}`,
  };
}

function tmplNewProviderCancel(s) {
  const fn = firstName(s.client_name);
  return {
    id: '07-new-provider-cancel',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

Totally understand. I've processed your cancellation. Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge date.

If anything changes, we'd love to welcome you back.${SIGNATURE}`,
  };
}

function tmplInconsistentCallback(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '36-inconsistent-callback',
    subject: 'A manager from Silver Mirror will reach out',
    body: `Hi ${fn},

Consistency is fair to expect, and I'm sorry it hasn't been there. ${loc.manager}, the ${loc.location} manager, will reach out to you at ${s.phone || 'your number on file'} within 24 hours to hear what's been inconsistent and put a plan in place.${SIGNATURE}`,
  };
}

function tmplInconsistentLead(s) {
  const fn = firstName(s.client_name);
  const loc = getLeadInfo(s.location);
  return {
    id: '35-inconsistent-lead',
    subject: 'Matching you with a consistent esthetician',
    body: `Hi ${fn},

Consistency shouldn't be hit or miss. ${loc.lead}, our lead esthetician at ${loc.location}, will match you with a specific esthetician whose style and approach lines up with what you're looking for. I'll send the recommendation within 48 hours.${SIGNATURE}`,
  };
}

function tmplParkingBrickell(s) {
  const fn = firstName(s.client_name);
  return {
    id: '37-parking-brickell',
    subject: 'Validated parking at Silver Mirror Brickell',
    body: `Hi ${fn},

Parking validation is available at Brickell — just let the front desk know when you arrive and they'll take care of it. I've also added a note to your profile so they know to validate automatically going forward.${SIGNATURE}`,
  };
}

function tmplParkingTransit(s) {
  const fn = firstName(s.client_name);
  return {
    id: '38-parking-transit',
    subject: 'A transit credit to make commuting easier',
    body: `Hi ${fn},

I've added a $20 transit credit to your account to help offset the commute. Use it toward a rideshare or transit pass on your facial day — whatever makes it easier.${SIGNATURE}`,
  };
}

function tmplLocationCancel(s) {
  const fn = firstName(s.client_name);
  return {
    id: '39-location-cancel',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

I understand — if the location isn't working, it's not working. I've processed your cancellation. Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge date.

If we ever open closer to you, we'd love to welcome you back.${SIGNATURE}`,
  };
}

function tmplLackValueAI(s) {
  const fn = firstName(s.client_name);
  return {
    id: '40-lack-value-ai',
    subject: 'Complimentary AI skin scans to show you what is working',
    body: `Hi ${fn},

Value should be tangible. I've added complimentary AI skin scans to your next visit — they'll show you an objective before-and-after view of your skin's progress, so the value isn't a feeling, it's a measurement.${SIGNATURE}`,
  };
}

function tmplLackValueFreeHydra(s) {
  const fn = firstName(s.client_name);
  return {
    id: '41-lack-value-hydra',
    subject: 'A complimentary HydraDerma on your next visit',
    body: `Hi ${fn},

Let me show you the upside of your membership. I've added a complimentary HydraDerma add-on to your next visit — one of our most impactful treatments — so you can feel the difference membership makes.${SIGNATURE}`,
  };
}

function tmplGenericCancelled(s) {
  const fn = firstName(s.client_name);
  return {
    id: '42-generic-cancelled',
    subject: 'Your Silver Mirror membership cancellation is confirmed',
    body: `Hi ${fn},

I've processed your cancellation. Your ${s.membership_tier}-minute membership will end after your next billing cycle, and no further charges will be made.

A few things to know:
• Your existing credits (${s.unused_credits || 0}) are usable for 90 days from your last charge date
• Any loyalty points can still be redeemed — just reply if you want help
• If anything changes, we'd love to welcome you back

Thanks for being a member.${SIGNATURE}`,
  };
}

// --- PUBLIC API -------------------------------------------------------------

function buildMemberDraft(summary) {
  try {
    const tmpl = pickTemplate(summary);
    return {
      templateId: tmpl.id,
      to: summary.email || '',
      subject: tmpl.subject,
      body: tmpl.body,
    };
  } catch (err) {
    console.warn('[member-draft] Failed to build draft:', err.message);
    return null;
  }
}

function renderDraftForAlert(draft) {
  if (!draft) return '';
  return `
======================================
DRAFT EMAIL TO MEMBER — Copy/paste to send
======================================
To: ${draft.to}
Subject: ${draft.subject}

${draft.body}

======================================
(Template: ${draft.templateId} — edit anything before sending)
======================================
`;
}

function renderDraftForHtml(draft) {
  if (!draft) return '';
  const esc = (str) => String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bodyHtml = esc(draft.body).replace(/\n/g, '<br>');
  return `
  <div style="margin-top: 24px; padding: 20px; background: #F7F9FB; border: 2px solid #2E4057; border-radius: 6px;">
    <h3 style="margin: 0 0 12px; color: #2E4057; font-family: Arial, sans-serif;">📧 Draft Email to Member</h3>
    <p style="margin: 0 0 8px; font-family: Arial, sans-serif; font-size: 13px; color: #666;"><strong>To:</strong> ${esc(draft.to)}</p>
    <p style="margin: 0 0 12px; font-family: Arial, sans-serif; font-size: 13px; color: #666;"><strong>Subject:</strong> ${esc(draft.subject)}</p>
    <div style="background: white; padding: 16px; border-radius: 4px; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${bodyHtml}</div>
    <p style="margin: 12px 0 0; font-family: Arial, sans-serif; font-size: 11px; color: #888;">Template: ${esc(draft.templateId)} — edit anything before sending.</p>
  </div>
  `;
}

export {
  buildMemberDraft,
  renderDraftForAlert,
  renderDraftForHtml,
};
