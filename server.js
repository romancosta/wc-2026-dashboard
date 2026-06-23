require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { exec } = require('child_process');

const app = express();
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';
const WC_ID = 2000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Cache
let espnCache = null;
let espnLastFetch = 0;
let fbdCache = null;
let fbdLastFetch = 0;
let standingsCache = null;
const matchFinishedAt = {};
let standingsLastFetch = 0;
let currentFocus = null;
let focusTimer = null;
const FOCUS_TIMEOUT_MS = 2 * 60 * 1000;
function clearFocusTimer() { if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; } }
function armFocusTimer(ms) { clearFocusTimer(); const d = (typeof ms === 'number' && ms > 0) ? ms : FOCUS_TIMEOUT_MS; focusTimer = setTimeout(function(){ currentFocus = null; focusTimer = null; }, d); }
function applyTtl(b) { const ttlSec = (b.ttl === undefined || b.ttl === null) ? 120 : Number(b.ttl); if (ttlSec > 0) armFocusTimer(ttlSec * 1000); else clearFocusTimer(); }

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
    `${BASE_URL}/competitions/${WC_ID}/matches`,
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
  'Miami Gardens, Florida': 'Miami',
  'Seattle, Washington': 'Seattle',
  'Kansas City, Missouri': 'Kansas City',
};


const KNOCKOUT_BRACKET = {
  '2026-06-28T19:00:00Z': { number: 73, home: { short: '2A', tla: '2A' }, away: { short: '2B', tla: '2B' } },
  '2026-06-29T17:00:00Z': { number: 76, home: { short: '1C', tla: '1C' }, away: { short: '2F', tla: '2F' } },
  '2026-06-29T20:30:00Z': { number: 74, home: { short: '1E', tla: '1E' }, away: { short: '3/A/B/C/D/F', tla: '3rd' } },
  '2026-06-30T01:00:00Z': { number: 75, home: { short: '1F', tla: '1F' }, away: { short: '2C', tla: '2C' } },
  '2026-06-30T17:00:00Z': { number: 78, home: { short: '2E', tla: '2E' }, away: { short: '2I', tla: '2I' } },
  '2026-06-30T21:00:00Z': { number: 77, home: { short: '1I', tla: '1I' }, away: { short: '3/C/D/F/G/H', tla: '3rd' } },
  '2026-07-01T01:00:00Z': { number: 79, home: { short: '1A', tla: '1A' }, away: { short: '3/C/E/F/H/I', tla: '3rd' } },
  '2026-07-01T16:00:00Z': { number: 80, home: { short: '1L', tla: '1L' }, away: { short: '3/E/H/I/J/K', tla: '3rd' } },
  '2026-07-01T20:00:00Z': { number: 82, home: { short: '1G', tla: '1G' }, away: { short: '3/A/E/H/I/J', tla: '3rd' } },
  '2026-07-02T00:00:00Z': { number: 81, home: { short: '1D', tla: '1D' }, away: { short: '3/B/E/F/I/J', tla: '3rd' } },
  '2026-07-02T19:00:00Z': { number: 84, home: { short: '1H', tla: '1H' }, away: { short: '2J', tla: '2J' } },
  '2026-07-02T23:00:00Z': { number: 83, home: { short: '2K', tla: '2K' }, away: { short: '2L', tla: '2L' } },
  '2026-07-03T03:00:00Z': { number: 85, home: { short: '1B', tla: '1B' }, away: { short: '3/E/F/G/I/J', tla: '3rd' } },
  '2026-07-03T18:00:00Z': { number: 88, home: { short: '2D', tla: '2D' }, away: { short: '2G', tla: '2G' } },
  '2026-07-03T22:00:00Z': { number: 86, home: { short: '1J', tla: '1J' }, away: { short: '2H', tla: '2H' } },
  '2026-07-04T01:30:00Z': { number: 87, home: { short: '1K', tla: '1K' }, away: { short: '3/D/E/I/J/L', tla: '3rd' } },
  '2026-07-04T17:00:00Z': { number: 90, home: { short: 'Winner M73', tla: 'W73' }, away: { short: 'Winner M75', tla: 'W75' } },
  '2026-07-04T21:00:00Z': { number: 89, home: { short: 'Winner M74', tla: 'W74' }, away: { short: 'Winner M77', tla: 'W77' } },
  '2026-07-05T20:00:00Z': { number: 91, home: { short: 'Winner M76', tla: 'W76' }, away: { short: 'Winner M78', tla: 'W78' } },
  '2026-07-06T00:00:00Z': { number: 92, home: { short: 'Winner M79', tla: 'W79' }, away: { short: 'Winner M80', tla: 'W80' } },
  '2026-07-06T19:00:00Z': { number: 93, home: { short: 'Winner M83', tla: 'W83' }, away: { short: 'Winner M84', tla: 'W84' } },
  '2026-07-07T00:00:00Z': { number: 94, home: { short: 'Winner M81', tla: 'W81' }, away: { short: 'Winner M82', tla: 'W82' } },
  '2026-07-07T16:00:00Z': { number: 95, home: { short: 'Winner M86', tla: 'W86' }, away: { short: 'Winner M88', tla: 'W88' } },
  '2026-07-07T20:00:00Z': { number: 96, home: { short: 'Winner M85', tla: 'W85' }, away: { short: 'Winner M87', tla: 'W87' } },
  '2026-07-09T20:00:00Z': { number: 97, home: { short: 'Winner M89', tla: 'W89' }, away: { short: 'Winner M90', tla: 'W90' } },
  '2026-07-10T19:00:00Z': { number: 98, home: { short: 'Winner M93', tla: 'W93' }, away: { short: 'Winner M94', tla: 'W94' } },
  '2026-07-11T21:00:00Z': { number: 99, home: { short: 'Winner M91', tla: 'W91' }, away: { short: 'Winner M92', tla: 'W92' } },
  '2026-07-12T01:00:00Z': { number: 100, home: { short: 'Winner M95', tla: 'W95' }, away: { short: 'Winner M96', tla: 'W96' } },
  '2026-07-14T19:00:00Z': { number: 101, home: { short: 'Winner M97', tla: 'W97' }, away: { short: 'Winner M98', tla: 'W98' } },
  '2026-07-15T19:00:00Z': { number: 102, home: { short: 'Winner M99', tla: 'W99' }, away: { short: 'Winner M100', tla: 'W100' } },
  '2026-07-18T21:00:00Z': { number: 103, home: { short: 'Loser M101', tla: 'L101' }, away: { short: 'Loser M102', tla: 'L102' } },
  '2026-07-19T19:00:00Z': { number: 104, home: { short: 'Winner M101', tla: 'W101' }, away: { short: 'Winner M102', tla: 'W102' } },
};

function applyBracketInfo(match) {
  const bracket = KNOCKOUT_BRACKET[match.utcDate];
  if (!bracket) return;
  match.matchNumber = bracket.number;
  if (!match.homeTeam.id) {
    match.homeTeam.shortName = bracket.home.short;
    match.homeTeam.tla = bracket.home.tla;
    match.homeTeam.name = bracket.home.short;
  }
  if (!match.awayTeam.id) {
    match.awayTeam.shortName = bracket.away.short;
    match.awayTeam.tla = bracket.away.tla;
    match.awayTeam.name = bracket.away.short;
  }
}

function normalize(str) { return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function matchTeams(fbdMatch, espnEntry) {
  if (!fbdMatch.homeTeam || !fbdMatch.homeTeam.shortName || !fbdMatch.awayTeam || !fbdMatch.awayTeam.shortName) return false;
  const fbdHome = normalize(fbdMatch.homeTeam.shortName);
  const fbdAway = normalize(fbdMatch.awayTeam.shortName);
  const espnHome = normalize(espnEntry.homeName || '');
  const espnAway = normalize(espnEntry.awayName || '');
  const homeMatch = fbdHome.includes(espnHome.slice(0,4)) || espnHome.includes(fbdHome.slice(0,4));
  const awayMatch = fbdAway.includes(espnAway.slice(0,4)) || espnAway.includes(fbdAway.slice(0,4));
  return homeMatch && awayMatch;
}

function etDateStr(utcDateStr) {
  const d = new Date(utcDateStr);
  const etMs = d.getTime() - (4 * 60 * 60 * 1000);
  const etDate = new Date(etMs);
  if (etDate.getUTCHours() < 1) etDate.setUTCDate(etDate.getUTCDate() - 1);
  return etDate.getUTCFullYear() + '-' + String(etDate.getUTCMonth() + 1).padStart(2, '0') + '-' + String(etDate.getUTCDate()).padStart(2, '0');
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
      applyBracketInfo(match);
      if (!match.homeTeam.id || !match.awayTeam.id) continue;
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

    let window;
    if (currentFocus && currentFocus.type === 'date') {
      window = allMatches.filter(function(m){ return etDateStr(m.utcDate) === currentFocus.date; }).sort(function(a,b){ return new Date(a.utcDate) - new Date(b.utcDate); });
    } else if (currentFocus && currentFocus.type === 'group') {
      window = allMatches.filter(function(m){ return m.group === 'GROUP_' + currentFocus.group; }).sort(function(a,b){ return new Date(a.utcDate) - new Date(b.utcDate); });
    } else if (currentFocus) {
      window = allMatches.filter(function(m){ return (m.homeTeam.id === currentFocus.id) || (m.awayTeam.id === currentFocus.id); }).sort(function(a,b){ return new Date(a.utcDate) - new Date(b.utcDate); });
    } else {
      window = selectWindow(allMatches);
    }
    res.json({ ...fbdData, matches: window, focus: currentFocus });
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

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

app.get('/api/control', function(req, res){ res.json({ focus: currentFocus }); });
app.post('/api/refresh', function(req, res){
  exec('WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 wtype -k F5', function(err){
    if (err) { console.error('refresh failed:', err.message); return res.status(500).json({ ok: false, error: err.message }); }
    res.json({ ok: true });
  });
});
app.post('/api/control', function(req, res){
  const b = req.body || {};
  if (b.clear) { currentFocus = null; clearFocusTimer(); return res.json({ focus: null }); }
  if (b.date) {
    currentFocus = { type: 'date', date: b.date, banner: 'Showing games on ' + (b.label || b.date) };
    applyTtl(b);
    return res.json({ focus: currentFocus });
  }
  if (b.group) {
    currentFocus = { type: 'group', group: b.group, banner: 'Showing Group ' + b.group };
    armFocusTimer(b.reset);
    return res.json({ focus: currentFocus });
  }
  if (b.id === undefined || b.id === null) { currentFocus = null; clearFocusTimer(); return res.json({ focus: null }); }
  currentFocus = { type: 'team', id: b.id, name: b.name || String(b.id), banner: 'Showing ' + (b.name || b.id) + ' only' };
  applyTtl(b);
  res.json({ focus: currentFocus });
});
app.get('/api/qr', async function(req, res){
  try {
    const host = getLocalIP() || (os.hostname() + '.local');
    const url = 'http://' + host + ':3000/remote.html';
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0a0e1a', light: '#ffffff' } });
    res.json({ url: url, svg: svg });
  } catch(e) { res.status(500).json({ error: 'qr failed' }); }
});
app.get('/api/teams', async function(req, res){
  try {
    const data = await fetchFBD();
    const teams = {};
    (data.matches || []).forEach(function(m){
      if (m.homeTeam && m.homeTeam.id) teams[m.homeTeam.id] = m.homeTeam;
      if (m.awayTeam && m.awayTeam.id) teams[m.awayTeam.id] = m.awayTeam;
    });
    const list = Object.values(teams).filter(function(t){ return t.name; }).sort(function(a,b){ return (a.shortName||a.name).localeCompare(b.shortName||b.name); });
    const rs = data.resultSet || {};
    res.json({ teams: list, firstDate: rs.first || null, lastDate: rs.last || null });
  } catch(e){ res.status(500).json({ error: 'failed' }); }
});

app.listen(3000, () => console.log('Dashboard running on http://localhost:3000'));
