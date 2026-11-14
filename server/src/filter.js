// Content filter for everything one person can show another: message text,
// nicknames and descriptions. App Store guideline 1.2 requires a way to stop
// objectionable content from being posted. This is a word and phrase list with
// normalisation against common evasions (leetspeak, accents, s.p.a.c.i.n.g,
// repeated letters). Extend it at deploy time with BLOCKLIST_EXTRA
// (comma-separated words or phrases).

// Strong insults and profanity aimed at people.
const PROFANITY = [
  'fuck', 'fucking', 'fucker', 'fucked', 'motherfucker', 'fuk', 'fck', 'stfu', 'gtfo',
  'shit', 'shithead', 'bullshit', 'bitch', 'bitches', 'bastard', 'asshole', 'arsehole',
  'dickhead', 'cunt', 'twat', 'wanker', 'prick', 'douchebag', 'jackass',
];
// Sexual content.
const SEXUAL = [
  'pussy', 'cock', 'dick', 'penis', 'vagina', 'boobs', 'tits', 'titties', 'nudes', 'send nudes',
  'blowjob', 'handjob', 'horny', 'dildo', 'porn', 'cum', 'jerk off', 'sex with you',
  'whore', 'slut', 'hoe', 'milf', 'onlyfans',
];
// Threats and self-harm baiting.
const THREATS = [
  'kill you', 'kill u', 'kill yourself', 'kys', 'gonna kill', 'murder you', 'shoot you',
  'stab you', 'beat you up', 'hurt you', 'rape', 'rapist', 'i will find you', 'follow you home',
  'know where you live', 'watch your back', 'you are dead', 'youre dead', 'die bitch',
];
// Slurs.
const SLURS = [
  'nigger', 'nigga', 'niggers', 'faggot', 'fag', 'fags', 'retard', 'retarded', 'tranny',
  'chink', 'spic', 'kike', 'wetback', 'dyke', 'gook', 'raghead', 'towelhead', 'beaner', 'coon',
];

export const DEFAULT_TERMS = [...PROFANITY, ...SEXUAL, ...THREATS, ...SLURS];

const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };

export function normalize(text) {
  let s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')        // accents
    .replace(/[​-‏⁠﻿]/g, '') // zero-width characters
    .toLowerCase()
    .replace(/[0-9!|@$+]/g, (c) => LEET[c] ?? c)
    .replace(/[’']/g, '');                  // "you're" -> "youre"
  // Join letters split by separators: "f.u.c.k", "k y s", "f*ck" stays "f ck".
  s = s.replace(/\b(?:[a-z][\s.\-_*~]){2,}[a-z]\b/g, (m) => m.replace(/[\s.\-_*~]/g, ''));
  s = s.replace(/[^a-z]+/g, ' ').trim();
  return s;
}

// "fuuuuck" -> "fuck"; also used on the terms so both sides agree.
const squeeze = (s) => s.replace(/([a-z])\1+/g, '$1');

export function createFilter(extra = []) {
  const terms = [...new Set([...DEFAULT_TERMS, ...extra].map((t) => normalize(t)).filter(Boolean))];
  // Match against both the normalized text and a squeezed version so
  // "fuuuck" is caught while words like "ass" in "class" never match.
  const compile = (list) => new RegExp(`(?:^| )(?:${list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?= |$)`);
  const plain = compile(terms);
  const squeezed = compile([...new Set(terms.map(squeeze))]);

  return {
    // Returns true when the text contains something objectionable.
    isBlocked(text) {
      if (!text) return false;
      const n = normalize(text);
      if (!n) return false;
      return plain.test(n) || squeezed.test(squeeze(n));
    },
  };
}

export function filterFromEnv(env = process.env) {
  const extra = (env.BLOCKLIST_EXTRA ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return createFilter(extra);
}
