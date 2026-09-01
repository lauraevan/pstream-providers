import { load } from 'cheerio';
import { makeProviders, makeStandardFetcher, targets } from '../../src/index';

export const config = {
  maxDuration: 60,
};

const fetcher = makeStandardFetcher(fetch);
const providers = makeProviders({
  fetcher,
  proxiedFetcher: fetcher,
  target: targets.BROWSER,
  externalSources: 'all',
  consistentIpForRequests: false,
});

const providerCount = providers.listSources().length;

type MovieMeta = {
  type: 'movie';
  title: string;
  releaseYear: number;
  tmdbId: string;
};

function cleanTitle(value: string) {
  return value
    .replace(/\s*[—–-]\s*The Movie Database\s*\(TMDB\).*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveWithOfficialApi(tmdbId: string): Promise<MovieMeta | null> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  if (!token && !apiKey) return null;

  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
  url.searchParams.set('language', 'en-US');
  if (apiKey) url.searchParams.set('api_key', apiKey);

  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
  });
  if (!response.ok) return null;

  const data = await response.json() as { title?: string; release_date?: string };
  const releaseYear = Number(data.release_date?.slice(0, 4));
  if (!data.title || !Number.isInteger(releaseYear)) return null;

  return {
    type: 'movie',
    title: data.title,
    releaseYear,
    tmdbId,
  };
}

async function resolveFromPublicPage(tmdbId: string): Promise<MovieMeta> {
  const response = await fetch(`https://www.themoviedb.org/movie/${tmdbId}?language=en-US`, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; PStreamPlayerDemo/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`TMDB returned ${response.status} while resolving movie metadata.`);
  }

  const html = await response.text();
  const $ = load(html);
  const pageTitle = $('title').first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || '';

  let title = cleanTitle(ogTitle || pageTitle);
  let releaseYear: number | undefined;

  const yearCandidates = [
    pageTitle.match(/\((\d{4})\)/)?.[1],
    $('.release').first().text().match(/(19|20)\d{2}/)?.[0],
    html.match(/"release_date"\s*:\s*"((?:19|20)\d{2})-\d{2}-\d{2}"/)?.[1],
    html.match(/&quot;release_date&quot;\s*:\s*&quot;((?:19|20)\d{2})-\d{2}-\d{2}/)?.[1],
  ];

  for (const candidate of yearCandidates) {
    const year = Number(candidate);
    if (Number.isInteger(year) && year >= 1880 && year <= new Date().getFullYear() + 5) {
      releaseYear = year;
      break;
    }
  }

  if (!title || /^The Movie Database/i.test(title)) {
    const jsonTitle = html.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)?.[1];
    if (jsonTitle) {
      try { title = JSON.parse(`"${jsonTitle}"`); } catch { title = jsonTitle; }
      title = cleanTitle(title);
    }
  }

  if (!title || !releaseYear) {
    throw new Error('Could not resolve the title/year from TMDB. Add TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in Vercel for a guaranteed metadata lookup.');
  }

  return {
    type: 'movie',
    title,
    releaseYear,
    tmdbId,
  };
}

async function resolveMovie(tmdbId: string): Promise<MovieMeta> {
  return (await resolveWithOfficialApi(tmdbId)) ?? resolveFromPublicPage(tmdbId);
}

function getTmdbId(req: any) {
  const raw = req?.query?.id ?? req?.body?.id;
  return Array.isArray(raw) ? String(raw[0] ?? '').trim() : String(raw ?? '').trim();
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Use GET or POST.' });
  }

  const tmdbId = getTmdbId(req);
  if (!/^\d{1,10}$/.test(tmdbId)) {
    return res.status(400).json({ error: 'A numeric TMDB movie ID is required.' });
  }

  try {
    const movie = await resolveMovie(tmdbId);
    const output = await Promise.race([
      providers.runAll({
        media: movie,
        disableOpensubtitles: true,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Provider scan timed out before a playable stream was found.')), 52_000);
      }),
    ]);

    if (!output) {
      return res.status(404).json({
        error: 'No browser-playable stream was found by the enabled providers.',
        movie,
        providerCount,
      });
    }

    return res.status(200).json({
      movie,
      providerCount,
      sourceId: output.sourceId,
      embedId: output.embedId ?? null,
      stream: output.stream,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provider error.';
    const status = /timed out/i.test(message) ? 504 : 500;
    return res.status(status).json({ error: message, providerCount });
  }
}
