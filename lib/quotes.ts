/**
 * Short motivational lines for the profile page and the Telegram bot.
 * Written for Livento, so there are no attributions to get wrong. Neutral voice
 * (DESIGN.md): encourage, never shame. Safe to import on the client and the server.
 */
export const QUOTES: readonly string[] = [
  "Future you is already at the show. Save the seat.",
  "Small amounts, big nights.",
  "Every week you save is a memory on its way.",
  "Collect moments, not receipts.",
  "A little every week turns “someday” into a date.",
  "The best souvenirs are stories.",
  "Front row starts with the first ten dollars.",
  "Saving is just booking in slow motion.",
  "Your weekends deserve a plan.",
  "The countdown is part of the fun.",
  "Every envelope is a promise to yourself.",
  "Good plans make great memories.",
  "Make room in your budget for wonder.",
  "The ticket is closer than it looks.",
  "Start small. Arrive early. Stay till the encore.",
  "You won’t remember the scroll. You’ll remember the show.",
  "One week at a time, all the way to the front row.",
  "Plan it once, enjoy it twice: now and when it happens.",
  "Life is short. Make the plans that make it long.",
  "Your future self says thanks in advance.",
  "Big trips are built from small Tuesdays.",
  "Some things are worth waiting for. This is one of them.",
  "The view from the festival field is worth every step.",
  "Money well saved is a night well spent.",
  "Dream it, price it, plan it, go.",
  "Steady beats sudden.",
  "A saved dollar is a ticket in progress.",
  "You’re not cutting back. You’re saving up.",
  "The applause will be worth it.",
  "Nothing feels like the lights going down.",
  "Turn “I wish I’d gone” into “I was there.”",
  "Memories don’t go on sale. Plans make them affordable.",
  "Another week closer to the good part.",
  "Your next favorite story is already on the calendar.",
  "Less someday, more Saturday.",
  "Keep going. The stage is getting closer.",
  "The plan is the first part of the trip.",
  "Experiences grow in value every time you retell them.",
  "Ready beats rushed.",
  "When the day comes, all you’ll need to do is show up.",
];

/** A random line, never the same index as `excludeIndex` (for "New quote"). */
export function randomQuote(excludeIndex?: number): { text: string; index: number } {
  const count = QUOTES.length;
  let index = Math.floor(Math.random() * count);
  if (count > 1 && index === excludeIndex) index = (index + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return { text: QUOTES[index], index };
}
