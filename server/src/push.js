// Push notification payloads. They never carry message text: the person
// has to accept before they can read it.

export function requestPushPayload(r) {
  const who = r.fromDescription ? `${r.fromNickname} · ${r.fromDescription}` : r.fromNickname;
  return {
    aps: {
      alert: { title: 'Whisper', body: `${who} wants to send you a message` },
      sound: 'default',
      category: 'WHISPER_REQUEST',
      'thread-id': 'whisper-requests',
    },
    kind: 'request',
    requestId: r.id,
  };
}

export function acceptedPushPayload(r) {
  const who = r.toDescription ? `${r.toNickname} · ${r.toDescription}` : r.toNickname;
  return {
    aps: { alert: { title: 'Whisper', body: `${who} accepted your message` }, sound: 'default', 'thread-id': 'whisper-sent' },
    kind: 'accepted',
    requestId: r.id,
  };
}
