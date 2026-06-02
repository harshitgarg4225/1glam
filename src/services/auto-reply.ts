// Guardrail for AI auto-reply: without explicit owner approval, the assistant
// must never auto-send anything that quotes a price or commits to payment or a
// confirmed booking. Such replies are held back for the owner to review and
// send manually. Kept in its own module so it can be unit-tested in isolation.
export function replyIsSafeToAutoSend(reply: string, ownerDecision?: string): boolean {
  if (ownerDecision === "YES" || ownerDecision === "EDIT") return true;
  const mentionsMoney = /₹|\bINR\b|\brupees?\b|\bRs\.?\b/i.test(reply);
  const mentionsCommitment = /\b(advance|deposit|booking is confirmed|confirmed your booking|pay(ment)? link)\b/i.test(reply);
  return !(mentionsMoney || mentionsCommitment);
}
