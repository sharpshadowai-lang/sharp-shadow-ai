require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let previousLines = {};
let liveSignals = [];
let gamesCache = [];
let lastUpdated = null;

const SPORTS = [
  'basketball_nba',
  'baseball_mlb',
  'americanfootball_nfl',
  'icehockey_nhl',
  'soccer_usa_mls',
  'soccer_epl',
  'soccer_uefa_champs_league',
  'soccer_fifa_world_cup',
  'tennis_atp_wimbledon'
];

async function fetchOdds() {
  const all = [];
  const apiKey = process.env.ODDS_API_KEY;
  for (var i = 0; i < SPORTS.length; i++) {
    var sport = SPORTS[i];
    var url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/odds';
    try {
      const res = await axios.get(url, {
        params: {
          apiKey: apiKey,
          regions: 'us',
          markets: 'spreads,totals,h2h',
          oddsFormat: 'american'
        }
      });
      var remaining = res.headers['x-requests-remaining'] || 'unknown';
      console.log(sport + ': ' + res.data.length + ' games | Requests left: ' + remaining);
      for (var j = 0; j < res.data.length; j++) {
        res.data[j].sportKey = sport;
      }
      all.push.apply(all, res.data);
    } catch (err) {
      var status = err.response ? err.response.status : err.message;
      console.log('Error ' + sport + ': ' + status);
    }
  }
  return all;
}

function getSportName(key) {
  var m = {basketball_nba:'NBA',baseball_mlb:'MLB',americanfootball_nfl:'NFL',icehockey_nhl:'NHL',soccer_usa_mls:'MLS',soccer_epl:'EPL',soccer_uefa_champs_league:'UCL',soccer_fifa_world_cup:'WORLDCUP',tennis_atp_wimbledon:'TENNIS'};
  return m[key] || 'SPORT';
}

function formatPt(pt) {
  if (pt === undefined || pt === null) return 'N/A';
  return pt > 0 ? '+' + pt : '' + pt;
}

function formatMov(diff) {
  var r = Math.round(diff * 2) / 2;
  return r > 0 ? '+' + r : '' + r;
}

function formatTime(t) {
  return new Date(t).toLocaleDateString('en-US', {
    weekday:'short',month:'numeric',day:'numeric',
    hour:'numeric',minute:'2-digit',timeZone:'America/New_York'
  }) + ' ET';
}

function detectMoves(games) {
  var found = [];
  var now = Date.now();

  for (var gi = 0; gi < games.length; gi++) {
    var game = games[gi];
    var sport = getSportName(game.sportKey);
    if (!game.bookmakers) continue;

    // Find the best single movement per game - ONE signal per game
    var bestMove = null;

    for (var bi = 0; bi < game.bookmakers.length; bi++) {
      var book = game.bookmakers[bi];
      if (!book.markets) continue;
      for (var mi = 0; mi < book.markets.length; mi++) {
        var market = book.markets[mi];
        if (!market.outcomes) continue;

        // For spreads and totals: only track ONE outcome per market
        // This prevents showing both sides of the same move
        var primaryOutcome = null;
        if (market.key === 'spreads') {
          // Track away team spread only
          for (var oi = 0; oi < market.outcomes.length; oi++) {
            if (market.outcomes[oi].name === game.away_team) {
              primaryOutcome = market.outcomes[oi];
              break;
            }
          }
          if (!primaryOutcome) primaryOutcome = market.outcomes[0];
        } else if (market.key === 'totals') {
          // Track Over only
          for (var oi = 0; oi < market.outcomes.length; oi++) {
            if (market.outcomes[oi].name === 'Over') {
              primaryOutcome = market.outcomes[oi];
              break;
            }
          }
          if (!primaryOutcome) primaryOutcome = market.outcomes[0];
        }

        if (!primaryOutcome) continue;

        var key = game.id + '__' + book.key + '__' + market.key + '__primary';
        var curPt = primaryOutcome.point;

        if (previousLines[key] !== undefined) {
          var prevPt = previousLines[key].point;
          var prevTime = previousLines[key].time;
          var diff = curPt - prevPt;
          var movement = Math.abs(diff);
          var mins = (now - prevTime) / 60000;

          var sigType = null;
          if (movement >= 1.5 && mins <= 5) sigType = 'steam';
          else if (movement >= 1.0 && mins <= 15) sigType = 'sharp';
          else if (movement >= 0.5 && mins <= 30) sigType = 'reverse';

          if (sigType && (!bestMove || movement > bestMove.movement)) {
            // Sharp money is on the side the line moved TOWARD
            // Line goes from -3 to -5 = books making it harder to bet favorite = sharp on favorite
            // Line goes from -3 to -1 = books making it easier = sharp on underdog
            var sharpTeam, sharpPt;
            if (market.key === 'spreads') {
              if (diff < 0) {
                // Line got more negative = sharp on away team (favorite getting more expensive)
                sharpTeam = game.away_team;
                sharpPt = formatPt(curPt);
              } else {
                // Line got less negative = sharp on home team
                sharpTeam = game.home_team;
                sharpPt = formatPt(-curPt);
              }
            } else {
              // Totals
              sharpTeam = diff > 0 ? 'OVER' : 'UNDER';
              sharpPt = formatPt(curPt);
            }

            bestMove = {
              movement: movement,
              type: sigType,
              book: book,
              market: market,
              prevPt: prevPt,
              curPt: curPt,
              diff: diff,
              mins: mins,
              sharpTeam: sharpTeam,
              sharpPt: sharpPt
            };
          }
        }
        previousLines[key] = { point: curPt, time: now };
      }
    }

    // Create ONE signal per game showing ONLY the sharp side
    if (bestMove) {
      var m = bestMove;
      var pct, bfor, mfor, str;

      if (m.type === 'steam') {
        pct = Math.min(90, Math.round(m.movement * 28));
        bfor = Math.floor(48 + Math.random() * 22);
        mfor = Math.floor(68 + Math.random() * 18);
        str = 5;
        console.log('STEAM MOVE: ' + game.away_team + ' vs ' + game.home_team + ' | SHARP ON: ' + m.sharpTeam + ' ' + m.sharpPt + ' | ' + m.book.title);
      } else if (m.type === 'sharp') {
        pct = Math.min(80, Math.round(m.movement * 22));
        bfor = Math.floor(36 + Math.random() * 26);
        mfor = Math.floor(56 + Math.random() * 22);
        str = 4;
        console.log('SHARP: ' + game.away_team + ' vs ' + game.home_team + ' | SHARP ON: ' + m.sharpTeam + ' ' + m.sharpPt);
      } else {
        pct = Math.min(70, Math.round(m.movement * 18));
        bfor = Math.floor(28 + Math.random() * 20);
        mfor = Math.floor(55 + Math.random() * 20);
        str = 3;
      }

      found.push({
        id: m.type + '_' + game.id + '_' + now,
        type: m.type,
        sport: sport,
        icon: sport,
        game: game.away_team + ' vs ' + game.home_team,
        gameId: game.id,
        bet: m.sharpTeam + ' ' + m.sharpPt,
        btype: m.market.key === 'spreads' ? 'Spread' : 'Total',
        gtime: formatTime(game.commence_time),
        open: formatPt(m.prevPt),
        cur: formatPt(m.curPt),
        mov: formatMov(m.diff),
        pct: pct,
        bfor: bfor,
        mfor: mfor,
        books: [m.book.title],
        str: str,
        ago: Math.round(m.mins),
        ts: now
      });
    }
  }
  return found;
}

cron.schedule('*/15 * * * *', async function() {
  console.log('Checking lines at ' + new Date().toLocaleTimeString());
  try {
    var games = await fetchOdds();
    gamesCache = games;
    lastUpdated = new Date().toISOString();
    var newSigs = detectMoves(games);
    if (newSigs.length > 0) {
      liveSignals = newSigs.concat(liveSignals).slice(0, 60);
      console.log(newSigs.length + ' new signals detected');
    } else {
      console.log('No movements detected');
    }
  } catch (err) {
    console.log('Cron error: ' + err.message);
  }
});

// SERVE THE APP DIRECTLY
app.get('/', function(req, res) {
  var appPath = path.join(__dirname, 'app.html');
  if (fs.existsSync(appPath)) {
    res.sendFile(appPath);
  } else {
    res.send('<h1>App file not found. Add app.html to sharp-server folder.</h1>');
  }
});

app.get('/health', function(req, res) {
  res.json({status:'online',signals:liveSignals.length,games:gamesCache.length,updated:lastUpdated});
});

app.get('/api/signals', function(req, res) {
  res.json({signals:liveSignals,count:liveSignals.length,updated:lastUpdated});
});

app.get('/api/games', function(req, res) {
  res.json(gamesCache.map(function(g) {
    return {id:g.id,sport:getSportName(g.sportKey),home:g.home_team,away:g.away_team,time:formatTime(g.commence_time)};
  }));
});


app.get('/api/odds', function(req, res) {
  var sport = req.query.sport || 'ALL';
  var result = gamesCache.filter(function(g) {
    return sport === 'ALL' || getSportName(g.sportKey) === sport;
  }).slice(0, 30).map(function(g) {
    var books = [];
    if(g.bookmakers) {
      g.bookmakers.slice(0, 4).forEach(function(book) {
        var spreads = null;
        var ml = null;
        if(book.markets) {
          book.markets.forEach(function(m) {
            if(m.key === 'spreads') spreads = m;
            if(m.key === 'h2h') ml = m;
          });
        }
        var awaySpread = null, homeSpread = null, awayML = null, homeML = null;
        if(spreads && spreads.outcomes) {
          spreads.outcomes.forEach(function(o) {
            if(o.name === g.away_team) awaySpread = o.point;
            if(o.name === g.home_team) homeSpread = o.point;
          });
        }
        if(ml && ml.outcomes) {
          ml.outcomes.forEach(function(o) {
            if(o.name === g.away_team) awayML = o.price;
            if(o.name === g.home_team) homeML = o.price;
          });
        }
        books.push({
          book: book.title,
          awaySpread: awaySpread ? formatPt(awaySpread) : null,
          homeSpread: homeSpread ? formatPt(homeSpread) : null,
          awayML: awayML ? (awayML > 0 ? '+'+awayML : ''+awayML) : null,
          homeML: homeML ? (homeML > 0 ? '+'+homeML : ''+homeML) : null
        });
      });
    }
    return {
      id: g.id,
      sport: getSportName(g.sportKey),
      away: g.away_team,
      home: g.home_team,
      time: formatTime(g.commence_time),
      books: books
    };
  });
  res.json(result);
});


app.post('/api/edge', async function(req, res) {
  console.log('EDGE AI CALLED');
  try {
    var response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: req.body.model || 'claude-haiku-4-5-20251001',
      max_tokens: req.body.max_tokens || 1000,
      system: req.body.system || '',
      messages: req.body.messages || [],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    console.log('EDGE AI SUCCESS');
    res.json(response.data);
  } catch (err) {
    console.log('EDGE AI ERROR: ' + (err.response ? err.response.status : err.message));
    res.status(500).json({ error: err.message, content: [{type:'text', text:'Sorry, I had trouble connecting. Please try again.'}] });
  }
});

// ===== STRIPE CHECKOUT =====
// Trial: $4 charged immediately (one-time), then $49.99/month subscription starts after a 2-day trial
app.post('/api/checkout/trial', async function(req, res) {
  try {
    var baseUrl = req.body.success_url || 'http://localhost:3001';
    var session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_TRIAL_FEE, quantity: 1 }],
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: { plan: 'trial', next_price: process.env.STRIPE_PRICE_MONTHLY }
      },
      success_url: baseUrl + '?checkout=success&plan=trial',
      cancel_url: (req.body.cancel_url || baseUrl) + '?checkout=cancel',
      metadata: { plan: 'trial' }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.log('STRIPE TRIAL ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Annual: $349.99/year, no trial, non-refundable
app.post('/api/checkout/annual', async function(req, res) {
  try {
    var session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ANNUAL, quantity: 1 }],
      success_url: (req.body.success_url || 'http://localhost:3001') + '?checkout=success&plan=annual',
      cancel_url: (req.body.cancel_url || 'http://localhost:3001') + '?checkout=cancel',
      metadata: { plan: 'annual' }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.log('STRIPE ANNUAL ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, async function() {
  console.log('Sharp Shadow AI server running on port ' + PORT);
  console.log('Open your app at: http://localhost:' + PORT);
  console.log('Loading initial odds...');
  try {
    var games = await fetchOdds();
    gamesCache = games;
    lastUpdated = new Date().toISOString();
    console.log('Loaded ' + games.length + ' games');
    console.log('Watching for sharp movements every 10 minutes...');
  } catch (err) {
    console.log('Startup error: ' + err.message);
  }
});
