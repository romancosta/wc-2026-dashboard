require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const path = require('path');

const app = express();
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';
const WC_ID = 2000;

app.use(express.static(path.join(__dirname, 'public')));

// Cache
let espnCache = null;
let espnLastFetch = 0;
let fbdCache = null;
let fbdLastFetch = 0;
let standingsCache = null;
const matchFinishedAt = {};
let standingsLastFetch = 0;

function isQuietHours() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const etMin = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  const etTotal = etHour * 60 + etMin;
  return etTotal >= 140 && etTotal < 700;
}

function getESPNDateStr(offsetDays) {
  const etOffset = 4 * 60 * 60 * 1000;
  const d = new Date(Date.now() - etOffset);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

async function fetchESPNForDate(dateStr) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateStr}`);
  return res.json();
}

async function fetchESPN() {
  const now = Date.now();
  if (espnCache && (isQuietHours() || now - espnLastFetch < 25000)) return espnCache;

  const [d0, d1, d2, d3, d4] = await Promise.all([
    fetchESPNForDate(getESPNDateStr(-2)),
    fetchESPNForDate(getESPNDateStr(-1)),
    fetchESPNForDate(getESPNDateStr(0)),
    fetchESPNForDate(getESPNDateStr(1)),
    fetchESPNForDate(getESPNDateStr(2)),
    fetchESPNForDate(getESPNDateStr(3)),
  ]);

  const allEvents = [
    ...(d0.events || []),
    ...(d1.events || []),
    ...(d2.events || []),
    ...(d3.events || []),
    ...(d4.events || []),
  ];

  const liveMap = {};

  for (const event of allEvents) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const status = comp.status?.type;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');

    const tvChannels = (comp.geoBroadcasts || [])
      .filter(b => b.region === 'us' && b.lang === 'en')
      .map(b => b.media?.shortName)
      .filter(Boolean);

    const goals = { home: [], away: [] };
    const redCards = { home: [], away: [] };

    for (const play of (comp.details || [])) {
      const athlete = play.athletesInvolved?.[0];
      const teamId = play.team?.id;
      const minute = play.clock?.displayValue || '';
      let name = (athlete?.shortName || '').replace(/\b(J[uú]nior)\b/gi, 'Jr.');

      name = name.replace(/^V[ií]n[ií]cius\s+Jr\./i, 'Vini Jr.');
      const isHome = teamId === home?.team?.id;
      const side = isHome ? 'home' : 'away';
      if (play.scoringPlay) {
        const label = play.ownGoal ? `${name} (OG)` : play.penaltyKick ? `${name} (P)` : name;
        goals[side].push({ name: label, minute, athleteId: athlete && athlete.id ? athlete.id : null });
      }
      if (play.redCard) redCards[side].push({ name, minute });
    }

    liveMap[event.id] = {
      state: status?.state,
      completed: status?.completed,
      displayClock: comp.status?.displayClock,
      statusName: status?.name,
      homeScore: home?.score ?? null,
      awayScore: away?.score ?? null,
      homeName: home?.team?.shortDisplayName,
      awayName: away?.team?.shortDisplayName,
      tv: tvChannels.join(' / ') || null,
      city: (() => {
        if (!comp.venue || !comp.venue.address) return null;
        const addr = comp.venue.address;
        const full = addr.city && addr.state ? `${addr.city}, ${addr.state}` : (addr.city || null);
        if (full && CITY_ALIASES[full]) return CITY_ALIASES[full];
        return addr.city || null;
      })(),
      goals,
      redCards,
    };
  }

  espnCache = liveMap;
  espnLastFetch = now;
  return liveMap;
}

async function fetchFBD() {
  const now = Date.now();
  if (fbdCache && (isQuietHours() || now - fbdLastFetch < 55000)) return fbdCache;

  const etOffset = 4 * 60 * 60 * 1000;
  const etNow = new Date(Date.now() - etOffset);
  const dateFrom = new Date(etNow); dateFrom.setUTCDate(etNow.getUTCDate() - 3);
  const dateTo   = new Date(etNow); dateTo.setUTCDate(etNow.getUTCDate() + 4);
  const fmt = d => d.toISOString().split('T')[0];

  const res = await fetch(
    `${BASE_URL}/competitions/${WC_ID}/matches?dateFrom=${fmt(dateFrom)}&dateTo=${fmt(dateTo)}`,
    { headers: { 'X-Auth-Token': API_KEY } }
  );
  const remaining = res.headers.get('X-Requests-Available-Minute');
  if (remaining && parseInt(remaining) < 2) await new Promise(r => setTimeout(r, 60000));
  const data = await res.json();
  fbdCache = data;
  fbdLastFetch = now;
  return data;
}

async function fetchStandings() {
  const now = Date.now();
  if (standingsCache && (isQuietHours() || now - standingsLastFetch < 55000)) return standingsCache;
  const res = await fetch(
    `${BASE_URL}/competitions/${WC_ID}/standings`,
    { headers: { 'X-Auth-Token': API_KEY } }
  );
  const data = await res.json();
  standingsCache = data;
  standingsLastFetch = now;
  return data;
}

const CITY_ALIASES = {
  'Inglewood, California': 'Los Angeles',
  'Santa Clara, California': 'San Francisco Bay Area',
  'East Rutherford, New Jersey': 'New York New Jersey',
  'Foxborough, Massachusetts': 'Boston',
  'Houston, Texas': 'Houston',
  'Arlington, Texas': 'Dallas',
  'Philadelphia, Pennsylvania': 'Philadelphia',
  'Atlanta, Georgia': 'Atlanta',
};

function normalize(str) { return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function matchTeams(fbdMatch, espnEntry) {
  const fbdHome = normalize(fbdMatch.homeTeam.shortName);
  const fbdAway = normalize(fbdMatch.awayTeam.shortName);
  const espnHome = normalize(espnEntry.homeName || '');
  const espnAway = normalize(espnEntry.awayName || '');
  const homeMatch = fbdHome.includes(espnHome.slice(0,4)) || espnHome.includes(fbdHome.slice(0,4));
  const awayMatch = fbdAway.includes(espnAway.slice(0,4)) || espnAway.includes(fbdAway.slice(0,4));
  return homeMatch && awayMatch;
}

function selectWindow(matches) {
  const now = Date.now();
  const sorted = [...matches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  // Find anchor: live first, then most recent finished, then next upcoming
  let anchorIdx = -1;

  // 1. Live match
  const liveIdx = sorted.findIndex(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
  if (liveIdx !== -1) anchorIdx = liveIdx;

  // 2. Most recently completed
  if (anchorIdx === -1) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].status === 'FINISHED') { anchorIdx = i; break; }
    }
  }

  // 3. Next upcoming
  if (anchorIdx === -1) {
    anchorIdx = sorted.findIndex(m => m.status === 'TIMED' || m.status === 'SCHEDULED');
  }

  // Fallback
  if (anchorIdx === -1) anchorIdx = 0;

  // Build window: 5 before, anchor, 4 after
  const BEFORE = 4;
  const AFTER = 5;
  const total = 10;

  let start = anchorIdx - BEFORE;
  let end = anchorIdx + AFTER;

  // Clamp and adjust
  if (start < 0) {
    end = Math.min(sorted.length - 1, end + Math.abs(start));
    start = 0;
  }
  // Also ensure we always try to show 10
  while ((end - start + 1) < Math.min(total, sorted.length) && end < sorted.length - 1) { end++; }
  if (end >= sorted.length) {
    start = Math.max(0, start - (end - sorted.length + 1));
    end = sorted.length - 1;
  }

  return sorted.slice(start, end + 1);
}

app.get('/api/fixtures', async (req, res) => {
  try {
    const [fbdData, espnLive] = await Promise.all([fetchFBD(), fetchESPN()]);
    const allMatches = fbdData.matches || [];

    for (const match of allMatches) {
      const espnEntry = Object.values(espnLive).find(e => matchTeams(match, e));
      if (!espnEntry) continue;

      const isLive = espnEntry.state === 'in';
      const isHalf = espnEntry.statusName === 'STATUS_HALFTIME';
      const isDone = espnEntry.completed;

      if (isLive || isHalf || isDone) {
        if (isLive) { match.status = 'IN_PLAY'; match.minute = espnEntry.displayClock?.replace("'", '') || null; }
        else if (isHalf) match.status = 'PAUSED';
        else match.status = 'FINISHED';
        match.score.fullTime.home = parseInt(espnEntry.homeScore) || 0;
        match.score.fullTime.away = parseInt(espnEntry.awayScore) || 0;
      }

      if (match.status === "FINISHED" && !matchFinishedAt[match.id]) { matchFinishedAt[match.id] = Date.now(); }
      match.goals = espnEntry.goals;
      match.redCards = espnEntry.redCards;
      match.tv = espnEntry.tv;
      match.city = espnEntry.city;
    }

    const window = selectWindow(allMatches);
    res.json({ ...fbdData, matches: window });
  } catch (err) {
    console.error(err);
    if (fbdCache) {
      return res.json({ ...fbdCache, matches: selectWindow(fbdCache.matches || []) });
    }
    res.status(500).json({ error: 'Failed to fetch fixtures' });
  }
});

function adjustStandings(standings, liveMatches) {
  // Build a flat map of teamId -> standing row for quick lookup
  const teamMap = {};
  for (const group of standings) {
    for (const row of group.table) {
      teamMap[row.team.id] = row;
    }
  }

  for (const match of liveMatches) {
    const isFinished = match.status === "FINISHED";
    if (isFinished) { const finishedAt = matchFinishedAt[match.id]; if (!finishedAt || Date.now() - finishedAt < 30 * 60000) continue; }
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;
    const homeRow = teamMap[homeId];
    const awayRow = teamMap[awayId];

    const liveHome = match.score.fullTime.home;
    const liveAway = match.score.fullTime.away;
    if (liveHome === null || liveAway === null) continue;

    // Determine what FBD currently thinks happened (stale)
    // We infer from won/draw/lost whether FBD has recorded a result
    // If playedGames includes this match, reverse it first
    const fbdRecordedHome = homeRow.playedGames > 0 && (homeRow.won > 0 || homeRow.draw > 0 || homeRow.lost > 0);
    const fbdRecordedAway = awayRow.playedGames > 0 && (awayRow.won > 0 || awayRow.draw > 0 || awayRow.lost > 0);

    // Only adjust if FBD has a stale result recorded for this match
    // We detect stale by checking if FBD winner differs from live score
    const fbdHomeWon = homeRow.won > 0 && awayRow.lost > 0;
    const fbdAwayWon = awayRow.won > 0 && homeRow.lost > 0;
    const fbdDraw = homeRow.draw > 0 && awayRow.draw > 0;

    let stalePts = { home: 0, away: 0 };
    let staleRecord = { home: { won:0,draw:0,lost:0,gf:0,ga:0 }, away: { won:0,draw:0,lost:0,gf:0,ga:0 } };

    // Reverse FBD stale contribution
    if (fbdHomeWon) {
      staleRecord.home = { won:1,draw:0,lost:0,gf:homeRow.goalsFor,ga:homeRow.goalsAgainst };
      staleRecord.away = { won:0,draw:0,lost:1,gf:awayRow.goalsFor,ga:awayRow.goalsAgainst };
      stalePts = { home:3, away:0 };
    } else if (fbdAwayWon) {
      staleRecord.home = { won:0,draw:0,lost:1,gf:homeRow.goalsFor,ga:homeRow.goalsAgainst };
      staleRecord.away = { won:1,draw:0,lost:0,gf:awayRow.goalsFor,ga:awayRow.goalsAgainst };
      stalePts = { home:0, away:3 };
    } else if (fbdDraw) {
      staleRecord.home = { won:0,draw:1,lost:0,gf:homeRow.goalsFor,ga:homeRow.goalsAgainst };
      staleRecord.away = { won:0,draw:1,lost:0,gf:awayRow.goalsFor,ga:awayRow.goalsAgainst };
      stalePts = { home:1, away:1 };
    }

    // Apply live score
    let livePts = { home:0, away:0 };
    let liveRecord = { home:{won:0,draw:0,lost:0}, away:{won:0,draw:0,lost:0} };
    if (liveHome > liveAway) {
      livePts = { home:3, away:0 };
      liveRecord = { home:{won:1,draw:0,lost:0}, away:{won:0,draw:0,lost:1} };
    } else if (liveAway > liveHome) {
      livePts = { home:0, away:3 };
      liveRecord = { home:{won:0,draw:0,lost:1}, away:{won:1,draw:0,lost:0} };
    } else {
      livePts = { home:1, away:1 };
      liveRecord = { home:{won:0,draw:1,lost:0}, away:{won:0,draw:1,lost:0} };
    }

    // Only adjust if FBD had recorded something for this match
    if (fbdHomeWon || fbdAwayWon || fbdDraw) {
      homeRow.points = homeRow.points - stalePts.home + livePts.home;
      awayRow.points = awayRow.points - stalePts.away + livePts.away;
      homeRow.won  = homeRow.won  - staleRecord.home.won  + liveRecord.home.won;
      homeRow.draw = homeRow.draw - staleRecord.home.draw + liveRecord.home.draw;
      homeRow.lost = homeRow.lost - staleRecord.home.lost + liveRecord.home.lost;
      awayRow.won  = awayRow.won  - staleRecord.away.won  + liveRecord.away.won;
      awayRow.draw = awayRow.draw - staleRecord.away.draw + liveRecord.away.draw;
      awayRow.lost = awayRow.lost - staleRecord.away.lost + liveRecord.away.lost;
      homeRow.goalDifference = homeRow.goalsFor - homeRow.goalsAgainst;
      awayRow.goalDifference = awayRow.goalsFor - awayRow.goalsAgainst;
    }
  }

  // Re-sort each group by points, then GD
  for (const group of standings) {
    group.table.sort((a,b) => b.points - a.points || b.goalDifference - a.goalDifference);
    group.table.forEach((row, i) => row.position = i + 1);
  }

  return standings;
}

app.get('/api/standings', async (req, res) => {
  try {
    const [standingsData, fixturesData, espnLive] = await Promise.all([
      fetchStandings(),
      fetchFBD(),
      fetchESPN()
    ]);

    // Get live matches with ESPN scores merged in
    const liveMatches = (fixturesData.matches || []).filter(m => {
      const espnEntry = Object.values(espnLive).find(e => matchTeams(m, e));
      if (espnEntry && (espnEntry.state === 'in' || espnEntry.statusName === 'STATUS_HALFTIME')) {
        m.status = espnEntry.state === 'in' ? 'IN_PLAY' : 'PAUSED';
        m.score.fullTime.home = parseInt(espnEntry.homeScore) || 0;
        m.score.fullTime.away = parseInt(espnEntry.awayScore) || 0;
      }
      return m.status === 'IN_PLAY' || m.status === 'PAUSED';
    });

    const standings = JSON.parse(JSON.stringify(standingsData.standings || []));
    const adjusted = adjustStandings(standings, liveMatches);

    res.json({ ...standingsData, standings: adjusted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

app.listen(3000, () => console.log('Dashboard running on http://localhost:3000'));
