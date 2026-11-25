// Demo mode for App Review. Reviewers have one phone and can't run scripts, so
// when someone's description is the secret REVIEW_DEMO_CODE, a "Test Bot"
// appears about 15 m away, follows them around, sends them a request, and
// auto-accepts and replies to anything they send it. The code is swapped for "App Review"
// as soon as it's seen, so nobody else nearby ever sees it.

const BOT_NICKNAME = 'Test Bot';
const BOT_DESCRIPTION = 'Grey Tesla';
const BOT_GREETING = 'Hi from Test Bot! This is a demo message. Try Accept, Decline or Report.';
const BOT_REPLY = 'Got it, thanks! This is an automatic reply from Test Bot.';
const OFFSET = { lat: 0.0001, lon: 0.0001 }; // about 15 m north-east

export function createDemo({ state, code, onRequest, onAccepted, onReply, now = () => Date.now() }) {
  const secret = (code ?? '').trim().toLowerCase();
  const bots = new Map(); // owner session id -> bot session id
  const botIds = new Set();

  const enabled = secret.length >= 6;
  const isDemoOwner = (s) => enabled && (s.description ?? '').trim().toLowerCase() === secret;

  function placeBot(owner) {
    const bot = state.sessions.get(bots.get(owner.id));
    if (!bot || !owner.loc) return null;
    bot.loc = { lat: owner.loc.lat + OFFSET.lat, lon: owner.loc.lon + OFFSET.lon, accuracy: 5, heading: null, at: now() };
    bot.lastActive = now();
    return bot;
  }

  // Call after a location update.
  function afterLocation(owner) {
    if (!enabled || !owner.loc) return;
    if (bots.has(owner.id)) { placeBot(owner); return; }
    if (!isDemoOwner(owner)) return;

    owner.description = 'App Review';
    const { id } = state.createSession({ nickname: BOT_NICKNAME, description: BOT_DESCRIPTION }, 'demo-bot');
    bots.set(owner.id, id);
    botIds.add(id);
    const bot = placeBot(owner);
    try {
      const { created } = state.sendRequest(bot, { to: owner.id, text: BOT_GREETING });
      for (const r of created) onRequest?.(owner, r);
    } catch {
      // The reviewer will still see the bot and can message it.
    }
  }

  // Call after someone sends requests: the bot accepts right away.
  function afterSend(created) {
    for (const r of created) {
      const bot = botIds.has(r.to) && state.sessions.get(r.to);
      if (!bot) continue;
      if (r.replyTo) continue; // a reply is already delivered; the bot doesn't answer back
      const { r: accepted, first } = state.accept(bot, r.id);
      if (!first) continue;
      const owner = state.sessions.get(accepted.from);
      onAccepted?.(owner, accepted);
      // Reply too, so a reviewer sees what a reply looks like.
      try {
        const { created: [reply] } = state.sendRequest(bot, { replyTo: accepted.id, text: BOT_REPLY });
        onReply?.(owner, reply);
      } catch {
        // e.g. the bot hit its send cap; the accept alone is enough.
      }
    }
  }

  function removeBotFor(ownerId) {
    const botId = bots.get(ownerId);
    if (!botId) return;
    bots.delete(ownerId);
    botIds.delete(botId);
    state.eraseSession(botId);
  }

  // Bots leave when their reviewer's session ends, however it ended.
  function sweep() {
    for (const ownerId of [...bots.keys()]) if (!state.sessions.has(ownerId)) removeBotFor(ownerId);
    for (const [ownerId, botId] of [...bots]) if (!state.sessions.has(botId)) { bots.delete(ownerId); botIds.delete(botId); }
  }

  return { enabled, afterLocation, afterSend, removeBotFor, sweep, isBot: (id) => botIds.has(id) };
}
