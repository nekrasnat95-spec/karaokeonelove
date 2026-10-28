// Собирает списки песен из Last.fm и сохраняет их в data/ru.json и data/en.json.
// Запускается в GitHub Actions; ключ берётся из секрета LASTFM_API_KEY.
//
// Как подбираем:
// 1. Для каждого стиля и языка берём топ песен по меткам стиля (например, "russian rock").
// 2. Для каждой песни смотрим её метки (а если их нет — метки исполнителя).
// 3. Песня подходит под настроение, если среди меток есть слово настроения.

import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.LASTFM_API_KEY;
if (!KEY) {
  console.error("Нет ключа: задай переменную LASTFM_API_KEY");
  process.exit(1);
}

const API = "https://ws.audioscrobbler.com/2.0/";
const POOL_SIZE = Number(process.env.POOL_SIZE || 200); // сколько песен берём по каждой метке стиля
const MAX_PER_LIST = 100; // сколько песен сохраняем в одном списке

const STYLE_TAGS = {
  ru: {
    "поп": ["russian pop"],
    "рок": ["russian rock", "русский рок"],
    "джаз": ["russian jazz"],
    "фолк": ["russian folk"],
    "шансон": ["russian chanson", "шансон"],
    "хип-хоп/рэп": ["russian rap", "russian hip-hop"],
    "диско/ретро": ["soviet", "russian disco", "russian 80s", "russian 90s"],
    "кантри": ["russian country"],
    "эстрада": ["estrada", "эстрада", "soviet pop"],
  },
  en: {
    "поп": ["pop"],
    "рок": ["rock", "classic rock"],
    "джаз": ["jazz"],
    "фолк": ["folk"],
    "шансон": ["chanson", "french chanson"],
    "хип-хоп/рэп": ["hip-hop", "rap"],
    "диско/ретро": ["disco", "80s", "70s"],
    "кантри": ["country"],
    "эстрада": ["easy listening", "crooner", "oldies"],
  },
};

// Слова, по которым узнаём настроение в метках песни.
const MOOD_WORDS = {
  "романтическое": ["romantic", "love", "love songs", "romance", "романтика", "любовь", "о любви"],
  "лирическое": ["ballad", "ballads", "mellow", "lyrical", "beautiful", "лирика", "лирическое", "баллада"],
  "весёлое": ["happy", "fun", "feel good", "cheerful", "позитив", "весело", "весёлое"],
  "энергичное": ["energetic", "party", "upbeat", "dance", "drive", "драйв", "энергичное"],
  "грустное": ["sad", "melancholy", "melancholic", "heartbreak", "грусть", "грустное", "грустные песни"],
  "ностальгическое": ["nostalgia", "nostalgic", "oldies", "memories", "ностальгия"],
  "дерзкое": ["badass", "aggressive", "attitude", "sexy", "sassy", "angry", "дерзко", "дерзкое"],
};

const CYRILLIC = /[а-яё]/i;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let lastCall = 0;
async function call(params) {
  for (let attempt = 1; ; attempt++) {
    // Не чаще ~4 запросов в секунду, чтобы не упереться в лимит Last.fm
    const wait = lastCall + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const url = API + "?" + new URLSearchParams({ ...params, api_key: KEY, format: "json" });
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json.error === 29 || res.status >= 500) throw new Error("лимит или сбой сервера");
      if (json.error) return null; // песня/метка не найдена — просто пропускаем
      return json;
    } catch (e) {
      if (attempt >= 5) { console.warn("Пропускаю запрос:", params, e.message); return null; }
      await sleep(2000 * attempt);
    }
  }
}

async function topTracks(tag) {
  const out = [];
  for (let page = 1; out.length < POOL_SIZE; page++) {
    const json = await call({ method: "tag.gettoptracks", tag, limit: 100, page });
    const tracks = json?.tracks?.track || [];
    if (!tracks.length) break;
    out.push(...tracks.map(t => ({ artist: t.artist.name, title: t.name })));
    if (tracks.length < 100) break;
  }
  return out.slice(0, POOL_SIZE);
}

const trackTagCache = new Map();
const artistTagCache = new Map();

async function tagsOf(artist, title) {
  const key = artist + "\u0000" + title;
  if (!trackTagCache.has(key)) {
    const json = await call({ method: "track.gettoptags", artist, track: title, autocorrect: 1 });
    trackTagCache.set(key, (json?.toptags?.tag || []).slice(0, 30).map(t => t.name.toLowerCase()));
  }
  let tags = trackTagCache.get(key);
  if (tags.length) return tags;

  if (!artistTagCache.has(artist)) {
    const json = await call({ method: "artist.gettoptags", artist, autocorrect: 1 });
    artistTagCache.set(artist, (json?.toptags?.tag || []).slice(0, 30).map(t => t.name.toLowerCase()));
  }
  return artistTagCache.get(artist);
}

function matchesMood(tags, mood) {
  const words = MOOD_WORDS[mood];
  return tags.some(tag => {
    const parts = tag.split(/[^\p{L}\d]+/u);
    return words.some(w => tag === w || (!w.includes(" ") && parts.includes(w)));
  });
}

function fitsLanguage(lang, t) {
  const cyr = CYRILLIC.test(t.artist + t.title);
  return lang === "ru" ? true : !cyr; // русские метки и так русские; из английских убираем кириллицу
}

async function build(lang) {
  const result = {};
  for (const mood of Object.keys(MOOD_WORDS)) result[mood] = {};
  const anyStyle = []; // все песни языка — для кнопки «Показать без учёта стиля»
  const seen = new Set();

  for (const [style, tags] of Object.entries(STYLE_TAGS[lang])) {
    // Собираем пул по меткам стиля, по очереди из каждой метки, без повторов
    const pools = [];
    for (const tag of tags) pools.push(await topTracks(tag));
    const pool = [];
    const inPool = new Set();
    for (let i = 0; i < POOL_SIZE && pool.length < POOL_SIZE; i++) {
      for (const p of pools) {
        const t = p[i];
        if (!t || !fitsLanguage(lang, t)) continue;
        const id = (t.artist + " — " + t.title).toLowerCase();
        if (inPool.has(id)) continue;
        inPool.add(id);
        pool.push(t);
      }
    }
    console.log(`${lang} / ${style}: ${pool.length} песен, смотрю метки…`);

    for (const t of pool) {
      t.tags = await tagsOf(t.artist, t.title);
      const id = (t.artist + " — " + t.title).toLowerCase();
      if (!seen.has(id)) { seen.add(id); anyStyle.push(t); }
    }

    for (const mood of Object.keys(MOOD_WORDS)) {
      result[mood][style] = pool
        .filter(t => matchesMood(t.tags, mood))
        .slice(0, MAX_PER_LIST)
        .map(t => [t.artist, t.title]);
    }
  }

  for (const mood of Object.keys(MOOD_WORDS)) {
    result[mood]._any = anyStyle
      .filter(t => matchesMood(t.tags, mood))
      .slice(0, MAX_PER_LIST)
      .map(t => [t.artist, t.title]);
  }
  return result;
}

await mkdir("data", { recursive: true });
for (const lang of ["ru", "en"]) {
  const data = await build(lang);
  const payload = { updated: new Date().toISOString().slice(0, 10), moods: data };
  await writeFile(`data/${lang}.json`, JSON.stringify(payload));
  for (const [mood, styles] of Object.entries(data)) {
    console.log(lang, mood, Object.entries(styles).map(([s, l]) => `${s}:${l.length}`).join(" "));
  }
}
console.log("Готово");
