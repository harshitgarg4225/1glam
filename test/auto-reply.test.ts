import { test } from "node:test";
import assert from "node:assert/strict";

const { replyIsSafeToAutoSend } = await import("../src/services/auto-reply.ts");

test("a friendly informational reply is safe to auto-send", () => {
  assert.equal(
    replyIsSafeToAutoSend("Hi Priya! Thank you for reaching out. Could you share the venue and timing?", ""),
    true,
  );
});

test("a reply quoting a rupee amount is held when the owner hasn't approved", () => {
  assert.equal(replyIsSafeToAutoSend("Your bridal package is ₹45,000 for the day.", ""), false);
  assert.equal(replyIsSafeToAutoSend("That will be Rs. 20000 including travel.", ""), false);
  assert.equal(replyIsSafeToAutoSend("The total comes to INR 30000.", ""), false);
});

test("a reply asking for an advance or confirming a booking is held without approval", () => {
  assert.equal(replyIsSafeToAutoSend("Please pay the advance to lock your date.", ""), false);
  assert.equal(replyIsSafeToAutoSend("Your booking is confirmed!", ""), false);
  assert.equal(replyIsSafeToAutoSend("Here is your payment link.", ""), false);
});

test("once the owner approves (YES/EDIT), price replies may auto-send", () => {
  assert.equal(replyIsSafeToAutoSend("Your quote of ₹45,000 is ready to review.", "YES"), true);
  assert.equal(replyIsSafeToAutoSend("As discussed, the advance is ₹15,000.", "EDIT"), true);
});

test("pending/NO decisions still gate money talk", () => {
  assert.equal(replyIsSafeToAutoSend("The advance is ₹15,000.", "NO"), false);
  assert.equal(replyIsSafeToAutoSend("The advance is ₹15,000.", undefined), false);
});
