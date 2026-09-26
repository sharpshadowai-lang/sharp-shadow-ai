require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'sharpshadow_jwt_secret_2025';

const app = express();
app.use(cors());

// ===== STRIPE WEBHOOK — must be BEFORE express.json() =====
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async function(req, res) {
  var sig = req.headers['stripe-signature'];
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  var event;

  try {
    if(!webhookSecret) {
      event = JSON.parse(req.body.toString());
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    }
  } catch(err) {
    console.log('WEBHOOK ERROR: ' + err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  console.log('WEBHOOK EVENT: ' + event.type);

  try {
    // Checkout completed — link stripe_customer_id to user by email
    if(event.type === 'checkout.session.completed') {
      var session = event.data.object;
      var email = session.customer_details ? session.customer_details.email : null;
      var customerId = session.customer;
      if(email) {
        var lowerEmail = email.toLowerCase().trim();
        // Try to update existing user first
        var updateRes = await supabase.from('users')
          .update({ stripe_customer_id: customerId, subscription_status: 'trialing' })
          .eq('email', lowerEmail);
        // If no user exists yet, pre-create a placeholder so manage sub works after signup
        var checkRes = await supabase.from('users').select('id').eq('email', lowerEmail).single();
        if(!checkRes.data) {
          await supabase.from('users').insert([{
            email: lowerEmail,
            stripe_customer_id: customerId,
            subscription_status: 'trialing',
            plan: 'trial'
          }]);
          console.log('WEBHOOK: Pre-created user for ' + lowerEmail);
        }
        console.log('WEBHOOK: Checkout completed - ' + lowerEmail + ' cid=' + customerId);
      }
    }

    // Subscription deleted (hard cancel — trial expired with no payment method, or manual cancel)
    if(event.type === 'customer.subscription.deleted') {
      var sub = event.data.object;
      var customerId = sub.customer;
      var periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      await supabase.from('users')
        .update({ subscription_status: 'cancelled', subscription_end: periodEnd })
        .eq('stripe_customer_id', customerId);
      console.log('WEBHOOK: Subscription deleted - customer ' + customerId);
    }

    // Subscription updated (trial→active, cancel_at_period_end, etc.)
    if(event.type === 'customer.subscription.updated') {
      var sub = event.data.object;
      var customerId = sub.customer;
      var stripeStatus = sub.status;
      var periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

      var dbStatus = 'active';
      if(stripeStatus === 'trialing') dbStatus = 'trialing';
      else if(stripeStatus === 'active') dbStatus = sub.cancel_at_period_end ? 'cancelling' : 'active';
      else if(stripeStatus === 'past_due') dbStatus = 'past_due';
      else if(stripeStatus === 'canceled' || stripeStatus === 'cancelled') dbStatus = 'cancelled';

      // Determine plan from price id
      var planUpdate = {};
      var prevStatus = event.data.previous_attributes ? event.data.previous_attributes.status : null;
      // When trial ends and becomes active, upgrade plan to monthly
      if(prevStatus === 'trialing' && stripeStatus === 'active') {
        planUpdate.plan = 'monthly';
      }

      await supabase.from('users')
        .update(Object.assign({ subscription_status: dbStatus, subscription_end: periodEnd }, planUpdate))
        .eq('stripe_customer_id', customerId);
      console.log('WEBHOOK: Subscription updated - ' + customerId + ' status: ' + dbStatus);
    }

    // Payment failed
    if(event.type === 'invoice.payment_failed') {
      var invoice = event.data.object;
      var customerId = invoice.customer;
      await supabase.from('users')
        .update({ subscription_status: 'past_due' })
        .eq('stripe_customer_id', customerId);
      console.log('WEBHOOK: Payment failed - customer ' + customerId);
    }

  } catch(err) {
    console.log('WEBHOOK PROCESSING ERROR: ' + err.message);
  }

  res.json({ received: true });
});

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
  'americanfootball_ncaaf',
  'basketball_ncaab'
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
  var m = {
    basketball_nba:'NBA',
    baseball_mlb:'MLB',
    americanfootball_nfl:'NFL',
    icehockey_nhl:'NHL',
    soccer_usa_mls:'MLS',
    soccer_epl:'EPL',
    soccer_uefa_champs_league:'UCL',
    soccer_fifa_world_cup:'WORLDCUP',
    americanfootball_ncaaf:'NCAAF',
    basketball_ncaab:'NCAAB'
  };
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

// =====================================================================
// SHARP MONEY MOVEMENT DETECTION
//
// Classifications:
//   NO SHARP EVIDENCE     — normal movement, isolated book, insufficient data
//   POSSIBLE SHARP ACTION — some supporting indicators, incomplete picture
//   STRONG SHARP MOVEMENT — meaningful move + multi-book + supporting factors
//   CONFIRMED MARKET MOVE — synchronized movement across major books, clear evidence
//
// Key rules:
//   - Line move alone does NOT prove sharp money
//   - Single-book move = at most POSSIBLE
//   - Price (juice) change ≠ line change — track points only
//   - Moving through a key number (3, 7, 10 in football) is more significant
//   - Multi-book synchronized move within short window = steam
//   - We never claim sharp move = guaranteed winner
// =====================================================================

// Key numbers by sport — crossing these is especially significant
var KEY_NUMBERS = {
  americanfootball_nfl:  [3, 7, 10, 14, 17],
  americanfootball_ncaaf:[3, 7, 10, 14, 17],
  basketball_nba:        [1, 2, 3, 5],
  basketball_ncaab:      [1, 2, 3, 5],
  baseball_mlb:          [1],
  icehockey_nhl:         [1]
};

function crossesKeyNumber(fromPt, toPt, sportKey) {
  var keyNums = KEY_NUMBERS[sportKey] || [];
  var lo = Math.min(Math.abs(fromPt), Math.abs(toPt));
  var hi = Math.max(Math.abs(fromPt), Math.abs(toPt));
  for (var i = 0; i < keyNums.length; i++) {
    var kn = keyNums[i];
    if (lo < kn && hi >= kn) return kn;
  }
  return null;
}

// Minimum point movement before we consider it a real line move (not juice)
function minLineMove(sportKey, marketKey) {
  if (marketKey === 'totals') return 1.0;   // 1pt minimum on totals
  return 0.5;                               // 0.5pt minimum on spreads
}

// "Notable" threshold — above this is meaningful, below is minor
function notableLineMove(sportKey, marketKey) {
  if (marketKey === 'totals') return 1.5;
  if (sportKey === 'americanfootball_nfl' || sportKey === 'americanfootball_ncaaf') return 1.0;
  return 1.0;
}

// Well-known market-making / sharp-friendly sportsbooks that move first
var SHARP_BOOKS = ['pinnacle', 'betcris', 'circa', 'bookmaker', 'heritage', 'betonlineag', 'lowvig'];
var MAJOR_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'williamhill_us', 'barstool', 'bet365'];

function isSharpBook(bookKey) {
  return SHARP_BOOKS.indexOf(bookKey.toLowerCase()) !== -1;
}
function isMajorBook(bookKey) {
  return MAJOR_BOOKS.indexOf(bookKey.toLowerCase()) !== -1;
}

function classifySharpMove(data) {
  var movement     = data.maxMovement;
  var bookCount    = data.booksMoved;
  var minsMoved    = data.minsMoved;
  var sharpBookMoved = data.sharpBookMoved;
  var majorFollowed  = data.majorBooksFollowed;
  var crossedKey   = data.crossedKeyNumber;
  var sportKey     = data.sportKey;
  var marketKey    = data.marketKey;

  var minThresh    = minLineMove(sportKey, marketKey);
  var notableThresh = notableLineMove(sportKey, marketKey);

  // Must clear minimum to count at all
  if (movement < minThresh) return { classification: 'NO_SHARP_EVIDENCE', confidence: 0 };

  // Score evidence points — each factor adds to confidence
  var score = 0;
  var evidence = [];

  // 1. Line movement size
  if (movement >= notableThresh) {
    score += 2;
    evidence.push('Meaningful line move (' + movement + ' pts)');
  } else {
    score += 1;
    evidence.push('Minor line move (' + movement + ' pts)');
  }

  // 2. Key number crossing (extra weight in football)
  if (crossedKey) {
    score += 3;
    evidence.push('Moved through key number (' + crossedKey + ')');
  }

  // 3. Multi-book confirmation
  if (bookCount >= 4) {
    score += 4;
    evidence.push(bookCount + ' books moved in sync — possible steam');
  } else if (bookCount === 3) {
    score += 3;
    evidence.push('3 books confirmed move');
  } else if (bookCount === 2) {
    score += 2;
    evidence.push('2 books moved same direction');
  } else {
    // Single book — major red flag for sharp label
    score += 0;
    evidence.push('Single book movement only');
  }

  // 4. Sharp/market-making book moved
  if (sharpBookMoved) {
    score += 3;
    evidence.push('Sharp-book (limit-accepting) moved first');
  }

  // 5. Major books followed sharp book
  if (majorFollowed >= 2) {
    score += 3;
    evidence.push(majorFollowed + ' major books followed');
  } else if (majorFollowed === 1) {
    score += 1;
    evidence.push('1 major book followed');
  }

  // 6. Speed of movement (steam indicator)
  if (minsMoved <= 5 && bookCount >= 3) {
    score += 3;
    evidence.push('Rapid synchronized movement (<5 min)');
  } else if (minsMoved <= 15 && bookCount >= 2) {
    score += 1;
    evidence.push('Quick movement (<15 min)');
  }

  // Classify by total score
  // Single-book moves cap at POSSIBLE regardless of score
  var classification, str;
  if (bookCount <= 1) {
    if (score >= 4) {
      classification = 'POSSIBLE_SHARP';
      str = 3;
    } else {
      classification = 'NO_SHARP_EVIDENCE';
      str = 1;
    }
  } else if (score >= 14) {
    classification = 'CONFIRMED_MARKET_MOVE';
    str = 6;
  } else if (score >= 9) {
    classification = 'STRONG_SHARP_MOVEMENT';
    str = 5;
  } else if (score >= 5) {
    classification = 'POSSIBLE_SHARP';
    str = 3;
  } else {
    classification = 'NO_SHARP_EVIDENCE';
    str = 1;
  }

  return { classification: classification, confidence: score, evidence: evidence, str: str };
}

function getSharpLabel(classification) {
  var labels = {
    'CONFIRMED_MARKET_MOVE':  '🔥 CONFIRMED MARKET MOVE',
    'STRONG_SHARP_MOVEMENT':  '⚡ STRONG SHARP MOVEMENT',
    'POSSIBLE_SHARP':         '📊 POSSIBLE SHARP ACTION',
    'NO_SHARP_EVIDENCE':      'NO SHARP EVIDENCE'
  };
  return labels[classification] || classification;
}

function getSharpType(classification) {
  var types = {
    'CONFIRMED_MARKET_MOVE': 'steam',
    'STRONG_SHARP_MOVEMENT': 'sharp',
    'POSSIBLE_SHARP':        'reverse',
    'NO_SHARP_EVIDENCE':     'none'
  };
  return types[classification] || 'none';
}

function detectMoves(games) {
  var found = [];
  var now = Date.now();

  for (var gi = 0; gi < games.length; gi++) {
    var game = games[gi];
    var sport = getSportName(game.sportKey);
    if (!game.bookmakers) continue;

    // Aggregate movement per market across all books
    var marketData = {};

    for (var bi = 0; bi < game.bookmakers.length; bi++) {
      var book = game.bookmakers[bi];
      if (!book.markets) continue;
      var bookKey = book.key || '';

      for (var mi = 0; mi < book.markets.length; mi++) {
        var market = book.markets[mi];
        if (market.key !== 'spreads' && market.key !== 'totals') continue;
        if (!market.outcomes) continue;

        // Track primary outcome: away team for spreads, Over for totals
        var primaryOutcome = null;
        if (market.key === 'spreads') {
          for (var oi = 0; oi < market.outcomes.length; oi++) {
            if (market.outcomes[oi].name === game.away_team) { primaryOutcome = market.outcomes[oi]; break; }
          }
          if (!primaryOutcome) primaryOutcome = market.outcomes[0];
        } else {
          for (var oi = 0; oi < market.outcomes.length; oi++) {
            if (market.outcomes[oi].name === 'Over') { primaryOutcome = market.outcomes[oi]; break; }
          }
          if (!primaryOutcome) primaryOutcome = market.outcomes[0];
        }

        if (!primaryOutcome || primaryOutcome.point === undefined) continue;

        var storeKey = game.id + '__' + bookKey + '__' + market.key;
        var curPt = primaryOutcome.point;

        if (!marketData[market.key]) {
          marketData[market.key] = {
            booksMoved: 0,
            maxMovement: 0,
            totalDiff: 0,
            directionVotes: 0,
            bookList: [],
            sharpBookMoved: false,
            majorBooksFollowed: 0,
            minsMoved: 9999,
            openPt: null,
            curPt: null,
            crossedKeyNumber: null,
            sportKey: game.sportKey,
            marketKey: market.key
          };
        }

        var md = marketData[market.key];
        md.curPt = curPt;

        if (previousLines[storeKey] !== undefined) {
          var prevPt = previousLines[storeKey].point;
          var prevTime = previousLines[storeKey].time;
          var diff = curPt - prevPt;
          var movement = Math.abs(diff);
          var mins = (now - prevTime) / 60000;
          var minThresh = minLineMove(game.sportKey, market.key);

          if (md.openPt === null) md.openPt = prevPt;

          // Only count if it's a real LINE move (not just juice)
          if (movement >= minThresh) {
            md.booksMoved++;
            md.totalDiff += diff;
            md.maxMovement = Math.max(md.maxMovement, movement);
            md.directionVotes += diff > 0 ? 1 : -1;
            md.bookList.push(book.title);
            md.minsMoved = Math.min(md.minsMoved, mins);

            // Check if a sharp-accepting book moved
            if (isSharpBook(bookKey)) md.sharpBookMoved = true;
            // Check if major public book is following
            else if (isMajorBook(bookKey)) md.majorBooksFollowed++;

            // Check for key number crossing
            if (!md.crossedKeyNumber) {
              var kn = crossesKeyNumber(prevPt, curPt, game.sportKey);
              if (kn) md.crossedKeyNumber = kn;
            }
          }
        } else {
          if (md.openPt === null) md.openPt = curPt;
        }

        previousLines[storeKey] = { point: curPt, time: now };
      }
    }

    // Score each market and pick the best signal for this game
    var bestSignal = null;

    var marketKeys = Object.keys(marketData);
    for (var mk = 0; mk < marketKeys.length; mk++) {
      var mKey = marketKeys[mk];
      var md = marketData[mKey];

      if (md.booksMoved === 0) continue;

      var result = classifySharpMove(md);
      if (result.classification === 'NO_SHARP_EVIDENCE') continue;

      // Which side is market action on?
      // Net direction of books: negative = away team getting shorter (sharps on away)
      //                          positive = away team getting longer (sharps on home)
      var netDir = md.directionVotes < 0 ? -1 : 1;
      var sharpSide, sharpPt, betType;

      if (mKey === 'spreads') {
        if (netDir < 0) {
          sharpSide = game.away_team;
          sharpPt = formatPt(md.curPt);
        } else {
          sharpSide = game.home_team;
          sharpPt = formatPt(-(md.curPt));
        }
        betType = 'Spread';
      } else {
        sharpSide = netDir > 0 ? 'OVER' : 'UNDER';
        sharpPt = '' + Math.abs(md.curPt);
        betType = 'Total';
      }

      var openPt = md.openPt !== null ? md.openPt : md.curPt;

      var signal = {
        id: result.classification + '_' + game.id + '_' + mKey + '_' + now,
        type: getSharpType(result.classification),
        sharpClass: result.classification,
        sharpLabel: getSharpLabel(result.classification),
        sport: sport,
        icon: sport,
        game: game.away_team + ' vs ' + game.home_team,
        gameId: game.id,
        bet: sharpSide + ' ' + sharpPt,
        btype: betType,
        gtime: formatTime(game.commence_time),
        open: formatPt(openPt),
        cur: formatPt(md.curPt),
        mov: formatMov(md.directionVotes < 0 ? -md.maxMovement : md.maxMovement),
        books: md.bookList.slice(0, 5),
        bookCount: md.booksMoved,
        sharpBookMoved: md.sharpBookMoved,
        crossedKey: md.crossedKeyNumber,
        confidence: result.confidence,
        evidence: result.evidence,
        str: result.str,
        ago: Math.round(md.minsMoved === 9999 ? 0 : md.minsMoved),
        ts: now,
        // Display fields
        pct: Math.min(95, result.confidence * 6),
        bfor: 0, // No ticket% from Odds API — never fabricate
        mfor: 0
      };

      if (!bestSignal || result.str > bestSignal.str) {
        bestSignal = signal;
      }
    }

    if (bestSignal) {
      // Surface POSSIBLE and above — CONFIRMED and STRONG are rare and important
      found.push(bestSignal);
      console.log(bestSignal.sharpLabel + ': ' + game.away_team + ' vs ' + game.home_team +
        ' | ' + bestSignal.bet + ' (' + bestSignal.btype + ')' +
        ' | Open: ' + bestSignal.open + ' → ' + bestSignal.cur +
        ' | Books: ' + bestSignal.bookCount +
        (bestSignal.sharpBookMoved ? ' | Sharp book moved' : '') +
        (bestSignal.crossedKey ? ' | KEY NUMBER: ' + bestSignal.crossedKey : '') +
        ' | ' + bestSignal.evidence.join('; '));
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
      console.log('No RLM movements detected this cycle');
    }
  } catch (err) {
    console.log('Cron error: ' + err.message);
  }
});

// SERVE THE APP
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
  res.json({signals:liveSignals,count:liveSignals.length,updated:lastUpdated,games:gamesCache.length});
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
        var totals = null;
        var ml = null;
        if(book.markets) {
          book.markets.forEach(function(m) {
            if(m.key === 'spreads') spreads = m;
            if(m.key === 'totals') totals = m;
            if(m.key === 'h2h') ml = m;
          });
        }
        var awaySpread = null, homeSpread = null, awayML = null, homeML = null;
        var overTotal = null, underTotal = null;
        if(spreads && spreads.outcomes) {
          spreads.outcomes.forEach(function(o) {
            if(o.name === g.away_team) awaySpread = o.point;
            if(o.name === g.home_team) homeSpread = o.point;
          });
        }
        if(totals && totals.outcomes) {
          totals.outcomes.forEach(function(o) {
            if(o.name === 'Over') overTotal = o.point;
            if(o.name === 'Under') underTotal = o.point;
          });
        }
        if(ml && ml.outcomes) {
          ml.outcomes.forEach(function(o) {
            if(o.name === g.away_team) awayML = o.price;
            if(o.name === g.home_team) homeML = o.price;
          });
        }
        var totalPt = overTotal || underTotal;
        books.push({
          book: book.title,
          awaySpread: awaySpread !== null ? formatPt(awaySpread) : null,
          homeSpread: homeSpread !== null ? formatPt(homeSpread) : null,
          awayML: awayML !== null ? (awayML > 0 ? '+'+awayML : ''+awayML) : null,
          homeML: homeML !== null ? (homeML > 0 ? '+'+homeML : ''+homeML) : null,
          total: totalPt !== null ? '' + totalPt : null
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

// ===== S.I.D.E. AI — Rate limited by plan =====
const TRIAL_CALL_LIMIT = 5;
const PAID_CALL_LIMIT = 10;
const ADMIN_CALL_LIMIT = 999;

var aiCallTracker = {};

function checkRateLimit(userId, plan) {
  var now = Date.now();
  var dayMs = 24 * 60 * 60 * 1000;
  var limit = plan === 'admin' ? ADMIN_CALL_LIMIT : (plan === 'monthly' || plan === 'annual') ? PAID_CALL_LIMIT : TRIAL_CALL_LIMIT;

  if(!aiCallTracker[userId]) aiCallTracker[userId] = { count: 0, resetAt: now + dayMs };
  if(now > aiCallTracker[userId].resetAt) {
    aiCallTracker[userId] = { count: 0, resetAt: now + dayMs };
  }
  aiCallTracker[userId].count++;
  return {
    allowed: aiCallTracker[userId].count <= limit,
    used: aiCallTracker[userId].count - 1,
    limit: limit
  };
}

setInterval(function() {
  var now = Date.now();
  Object.keys(aiCallTracker).forEach(function(uid) {
    if(now > aiCallTracker[uid].resetAt) delete aiCallTracker[uid];
  });
}, 60 * 60 * 1000);

app.post('/api/edge', async function(req, res) {
  var token = req.body.token || req.headers['authorization'] || '';
  token = token.replace('Bearer ', '');

  var userId = 'anon_' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown');
  var plan = 'trial';

  if(token) {
    try {
      var decoded = jwt.verify(token, JWT_SECRET);
      userId = 'user_' + decoded.id;
      // Always read plan from DB to avoid stale JWT
      var planRes = await supabase.from('users').select('plan, subscription_status').eq('id', decoded.id).single();
      if(planRes.data) {
        plan = planRes.data.plan || 'trial';
        // Check subscription is still valid
        var status = planRes.data.subscription_status;
        if(status === 'cancelled' || status === 'past_due') {
          return res.status(403).json({ error: 'Subscription inactive', content: [{type:'text', text:'Your subscription is not active. Please resubscribe at sharpshadowai.com.'}] });
        }
      }
    } catch(e) {
      // Invalid token — treat as trial
    }
  }

  var rateCheck = checkRateLimit(userId, plan);
  if(!rateCheck.allowed) {
    var limitMsg = plan === 'trial'
      ? 'You have used all ' + TRIAL_CALL_LIMIT + ' of your free trial AI calls. Subscribe to get 10 calls per day.'
      : 'You have reached your daily limit of ' + PAID_CALL_LIMIT + ' S.I.D.E. AI calls. Your limit resets at midnight.';
    console.log('AI RATE LIMITED: ' + userId + ' plan=' + plan);
    return res.status(429).json({
      error: 'Daily limit reached',
      content: [{type:'text', text: limitMsg}]
    });
  }

  console.log('SIDE AI CALLED: ' + userId + ' plan=' + plan + ' call=' + (rateCheck.used+1) + '/' + rateCheck.limit);
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
    console.log('SIDE AI SUCCESS: ' + userId);
    res.json(response.data);
  } catch (err) {
    console.log('SIDE AI ERROR: ' + (err.response ? err.response.status : err.message));
    if (err.response && err.response.data) {
      console.log('SIDE AI ERROR DETAIL: ' + JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: err.message, content: [{type:'text', text:'Sorry, I had trouble connecting. Please try again.'}] });
  }
});

// ===== STRIPE CHECKOUT =====

// Trial: 2-day free trial then $79.99/month
app.post('/api/checkout/trial', async function(req, res) {
  try {
    var baseUrl = req.body.success_url || process.env.APP_URL || 'http://localhost:3001';
    var session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 2,
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' }
        }
      },
      payment_method_collection: 'always',
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

// Annual: $349.99/year
app.post('/api/checkout/annual', async function(req, res) {
  try {
    var baseUrl = req.body.success_url || process.env.APP_URL || 'http://localhost:3001';
    var session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ANNUAL, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: baseUrl + '?checkout=success&plan=annual',
      cancel_url: (req.body.cancel_url || baseUrl) + '?checkout=cancel',
      metadata: { plan: 'annual' }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.log('STRIPE ANNUAL ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTH ENDPOINTS =====

// Sign up — called after successful Stripe checkout
app.post('/api/auth/signup', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';
    var plan = req.body.plan || 'trial';

    if(!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if(password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    var hash = await bcrypt.hash(password, 10);

    // Check if webhook pre-created a record for this email
    var existing = await supabase.from('users').select('*').eq('email', email).single();

    if(existing.data) {
      // If it's a full account (has password_hash), reject duplicate signup
      if(existing.data.password_hash) {
        return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
      }
      // Webhook pre-created record — just fill in the password and plan
      var updateRes = await supabase.from('users')
        .update({ password_hash: hash, plan: plan, subscription_status: 'trialing' })
        .eq('email', email);
      if(updateRes.error) throw updateRes.error;

      var token = jwt.sign({ id: existing.data.id, email: email, plan: plan }, JWT_SECRET, { expiresIn: '30d' });
      console.log('NEW USER LINKED (webhook pre-created): ' + email + ' plan: ' + plan);
      return res.json({ success: true, token: token, email: email, plan: plan });
    }

    // Brand new user (no webhook pre-create) — create fresh
    var result = await supabase.from('users').insert([{
      email: email,
      password_hash: hash,
      plan: plan,
      subscription_status: 'trialing'
    }]).select().single();

    if(result.error) throw result.error;

    var token = jwt.sign({ id: result.data.id, email: email, plan: plan }, JWT_SECRET, { expiresIn: '30d' });
    console.log('NEW USER SIGNUP: ' + email + ' plan: ' + plan);
    res.json({ success: true, token: token, email: email, plan: plan });
  } catch(err) {
    console.log('SIGNUP ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log in
app.post('/api/auth/login', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if(!email || !password) return res.status(400).json({ error: 'Email and password required' });

    var result = await supabase.from('users').select('*').eq('email', email).single();
    if(!result.data) return res.status(401).json({ error: 'No account found with this email. Please sign up first.' });

    var user = result.data;

    if(!user.password_hash) return res.status(401).json({ error: 'Account setup incomplete. Please use Forgot Password to set your password.' });
    if(user.subscription_status === 'cancelled') return res.status(401).json({ error: 'Your subscription has been cancelled. Please resubscribe to continue.' });

    var valid = await bcrypt.compare(password, user.password_hash);
    if(!valid) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    var token = jwt.sign({ id: user.id, email: email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
    console.log('USER LOGIN: ' + email);
    res.json({ success: true, token: token, email: email, plan: user.plan });
  } catch(err) {
    console.log('LOGIN ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify token
app.post('/api/auth/verify', async function(req, res) {
  try {
    var token = req.body.token || '';
    if(!token) return res.status(401).json({ valid: false });
    var decoded = jwt.verify(token, JWT_SECRET);

    var result = await supabase.from('users').select('subscription_status, plan, subscription_end').eq('id', decoded.id).single();
    if(!result.data) return res.json({ valid: false });

    var status = result.data.subscription_status;
    var subEnd = result.data.subscription_end;
    var plan = result.data.plan;

    var hasAccess = false;
    if(status === 'active' || status === 'trialing' || status === 'cancelling') {
      hasAccess = true;
    } else if(status === 'cancelled' && subEnd && plan !== 'trial') {
      // Only give grace period to paid customers, not trial users
      hasAccess = new Date(subEnd) > new Date();
    }

    if(!hasAccess) return res.json({ valid: false });
    res.json({ valid: true, email: decoded.email, plan: plan, status: status });
  } catch(err) {
    res.json({ valid: false });
  }
});

// Forgot password
app.post('/api/auth/forgot-password', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    if(!email) return res.status(400).json({ error: 'Email required' });

    var result = await supabase.from('users').select('id').eq('email', email).single();
    if(!result.data) {
      // Don't reveal if email exists
      return res.json({ success: true, message: 'If an account exists with this email, you will receive a reset link.' });
    }

    var resetToken = require('crypto').randomBytes(32).toString('hex');
    var resetExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await supabase.from('users')
      .update({ reset_token: resetToken, reset_token_expiry: resetExpiry })
      .eq('email', email);

    var appUrl = process.env.APP_URL || 'https://sharpshadowai.com';
    var resetUrl = appUrl + '?reset_token=' + resetToken;

    await axios.post('https://api.resend.com/emails', {
      from: 'Sharp Shadow AI <noreply@sharpshadowai.com>',
      to: [email],
      subject: 'Reset Your Sharp Shadow AI Password',
      html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#020408;color:#e8f4f8;padding:40px;border:1px solid rgba(0,245,255,.2)">' +
        '<h2 style="color:#00f5ff;font-family:monospace;letter-spacing:2px">SHARP SHADOW AI</h2>' +
        '<p style="color:#9ec8d8;margin:24px 0">You requested a password reset. Click the button below to set a new password. This link expires in 1 hour.</p>' +
        '<a href="' + resetUrl + '" style="display:inline-block;background:#00f5ff;color:#020408;font-weight:bold;padding:14px 32px;text-decoration:none;font-family:monospace;letter-spacing:1px">RESET PASSWORD</a>' +
        '<p style="color:#4a7a8a;font-size:12px;margin-top:32px">If you did not request this, ignore this email. Questions? support@sharpshadowai.com</p>' +
        '</div>'
    }, {
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }
    });

    console.log('PASSWORD RESET SENT: ' + email);
    res.json({ success: true, message: 'Password reset link sent to your email.' });
  } catch(err) {
    console.log('FORGOT PASSWORD ERROR: ' + err.message);
    res.status(500).json({ error: 'Failed to send reset email. Please try again or contact support@sharpshadowai.com' });
  }
});

// Reset password
app.post('/api/auth/reset-password', async function(req, res) {
  try {
    var token = req.body.token || '';
    var password = req.body.password || '';

    if(!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if(password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    var result = await supabase.from('users').select('id, reset_token_expiry').eq('reset_token', token).single();
    if(!result.data) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    if(new Date(result.data.reset_token_expiry) < new Date()) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    var hash = await bcrypt.hash(password, 10);
    await supabase.from('users')
      .update({ password_hash: hash, reset_token: null, reset_token_expiry: null })
      .eq('id', result.data.id);

    console.log('PASSWORD RESET SUCCESS: user id=' + result.data.id);
    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch(err) {
    console.log('RESET PASSWORD ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MANAGE SUBSCRIPTION (Stripe Customer Portal) =====
app.post('/api/customer-portal', async function(req, res) {
  try {
    var token = req.body.token || '';
    var decoded = jwt.verify(token, JWT_SECRET);
    var result = await supabase.from('users').select('stripe_customer_id').eq('id', decoded.id).single();
    console.log('PORTAL: user id=' + decoded.id + ' stripe_customer_id=' + (result.data ? result.data.stripe_customer_id : 'none'));
    if(!result.data || !result.data.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found. Please contact support@sharpshadowai.com' });
    }
    var session = await stripe.billingPortal.sessions.create({
      customer: result.data.stripe_customer_id,
      return_url: process.env.APP_URL || 'https://sharpshadowai.com'
    });
    res.json({ url: session.url });
  } catch(err) {
    console.log('PORTAL ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, async function() {
  console.log('Sharp Shadow AI server running on port ' + PORT);
  console.log('Sharp Money Detection: CONFIRMED = multi-book sync + sharp book + key number');
  console.log('Sharp Money Detection: STRONG = notable move + 2+ books + supporting factors');
  console.log('Sharp Money Detection: POSSIBLE = some indicators, incomplete picture');
  console.log('Loading initial odds...');
  try {
    var games = await fetchOdds();
    gamesCache = games;
    lastUpdated = new Date().toISOString();
    console.log('Loaded ' + games.length + ' games');
  } catch (err) {
    console.log('Startup error: ' + err.message);
  }
});
