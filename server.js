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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let previousLines = {};
let liveSignals = [];
let gamesCache = [];
let lastUpdated = null;

const SPORTS = [
  'americanfootball_nfl',
  'baseball_mlb',
  'basketball_nba',
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
    americanfootball_nfl:'NFL',
    baseball_mlb:'MLB',
    basketball_nba:'NBA',
    americanfootball_ncaaf:'NCAAF',
    basketball_ncaab:'NCAAB'
  };
  return m[key] || 'SPORT';
}

function formatPt(pt) {
  if (pt === undefined || pt === null) return 'N/A';
  return pt > 0 ? '+' + pt : '' + pt;
}

function formatTotal(pt) {
  if (pt === undefined || pt === null) return 'N/A';
  return '' + pt;
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
              sharpPt = formatTotal(curPt);
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
        open: m.market.key === 'totals' ? formatTotal(m.prevPt) : formatPt(m.prevPt),
        cur: m.market.key === 'totals' ? formatTotal(m.curPt) : formatPt(m.curPt),
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


// Cost-based rate limiter — trial vs paid limits
var aiCallTracker = {};
var COST_PER_CALL = 0.08;        // estimated average cost per AI call
var COST_PER_PICKS = 0.15;       // estimated cost per daily picks generation

// Trial limits: 5 AI calls + 2 daily picks per day
var TRIAL_CALL_LIMIT = 5;
var TRIAL_PICKS_LIMIT = 2;

// Paid limits: 10 AI calls + unlimited picks (cached anyway)
var PAID_CALL_LIMIT = 10;
var PAID_PICKS_LIMIT = 999;

function getTracker(ip) {
  var now = Date.now();
  var dayMs = 24 * 60 * 60 * 1000;
  if(!aiCallTracker[ip] || now > aiCallTracker[ip].resetAt) {
    aiCallTracker[ip] = { calls: 0, picks: 0, resetAt: now + dayMs };
  }
  return aiCallTracker[ip];
}

function checkRateLimit(ip, isTrial, type) {
  var tracker = getTracker(ip);
  var callLimit = isTrial ? TRIAL_CALL_LIMIT : PAID_CALL_LIMIT;
  var picksLimit = isTrial ? TRIAL_PICKS_LIMIT : PAID_PICKS_LIMIT;

  if(type === 'picks') {
    if(tracker.picks >= picksLimit) return false;
    tracker.picks++;
    return true;
  } else {
    if(tracker.calls >= callLimit) return false;
    tracker.calls++;
    return true;
  }
}

function getRemainingCalls(ip, isTrial) {
  var tracker = getTracker(ip);
  var callLimit = isTrial ? TRIAL_CALL_LIMIT : PAID_CALL_LIMIT;
  return Math.max(0, callLimit - tracker.calls);
}

function getRemainingPicks(ip, isTrial) {
  var tracker = getTracker(ip);
  var picksLimit = isTrial ? TRIAL_PICKS_LIMIT : PAID_PICKS_LIMIT;
  return Math.max(0, picksLimit - tracker.picks);
}

// Clean up old entries every hour
setInterval(function() {
  var now = Date.now();
  Object.keys(aiCallTracker).forEach(function(ip) {
    if(now > aiCallTracker[ip].resetAt) delete aiCallTracker[ip];
  });
}, 60 * 60 * 1000);

app.post('/api/edge', async function(req, res) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  
  // Determine if trial or paid user from token
  var isTrial = true; // default to trial limits for safety
  var callType = req.body.callType || 'chat'; // 'chat' or 'picks'
  try {
    var token = req.body.token || req.headers['authorization'] || '';
    if(token) {
      var decoded = jwt.verify(token, JWT_SECRET);
      isTrial = decoded.plan === 'trial';
    }
  } catch(e) { isTrial = true; }

  var remaining = getRemainingCalls(ip, isTrial);
  
  if(!checkRateLimit(ip, isTrial, callType)) {
    console.log('EDGE AI RATE LIMITED: ' + ip + ' (trial: ' + isTrial + ', type: ' + callType + ')');
    var limitMsg = isTrial 
      ? 'You have reached your trial limit of ' + TRIAL_CALL_LIMIT + ' S.I.D.E. AI calls per day. Start your subscription to unlock ' + PAID_CALL_LIMIT + ' calls per day!'
      : 'You have reached your daily S.I.D.E. AI limit. Your limit resets at midnight. Come back tomorrow for fresh analysis!';
    if(callType === 'picks') {
      limitMsg = isTrial
        ? 'You have reached your trial limit of ' + TRIAL_PICKS_LIMIT + ' Daily Picks refreshes. Subscribe to unlock more!'
        : 'Daily picks limit reached. Come back tomorrow!';
    }
    return res.status(429).json({ 
      error: 'Daily limit reached',
      remaining: 0,
      content: [{type:'text', text:'⚠️ ' + limitMsg}]
    });
  }
  console.log('EDGE AI CALLED - ' + (isTrial ? 'TRIAL' : 'PAID') + ' user - ' + callType + ' - remaining: ' + getRemainingCalls(ip, isTrial));
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
    var responseData = response.data;
    responseData.remaining = getRemainingCalls(ip, isTrial);
    responseData.remainingPicks = getRemainingPicks(ip, isTrial);
    res.json(responseData);
  } catch (err) {
    console.log('EDGE AI ERROR: ' + (err.response ? err.response.status : err.message));
    if (err.response && err.response.data) {
      console.log('EDGE AI ERROR DETAIL: ' + JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: err.message, content: [{type:'text', text:'Sorry, I had trouble connecting. Please try again.'}] });
  }
});

// ===== STRIPE CHECKOUT =====
// Trial: $4 charged immediately (one-time), then $49.99/month subscription starts after a 2-day trial
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

// Annual: $349.99/year, no trial, non-refundable
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

// Sign up — called after successful Stripe payment
app.post('/api/auth/signup', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';
    var plan = req.body.plan || 'trial';

    if(!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if(password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if email already exists
    var existing = await supabase.from('users').select('id').eq('email', email).single();
    if(existing.data) return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });

    // Hash password
    var hash = await bcrypt.hash(password, 10);

    // Create user in database
    var result = await supabase.from('users').insert([{
      email: email,
      password_hash: hash,
      plan: plan,
      subscription_status: 'active'
    }]).select().single();

    if(result.error) throw result.error;

    // Generate JWT token
    var token = jwt.sign({ id: result.data.id, email: email, plan: plan }, JWT_SECRET, { expiresIn: '30d' });

    console.log('NEW USER SIGNUP: ' + email + ' plan: ' + plan);
    res.json({ success: true, token: token, email: email, plan: plan });
  } catch(err) {
    console.log('SIGNUP ERROR: ' + err.message);
    console.log('SIGNUP ERROR DETAIL: ' + JSON.stringify(err));
    res.status(500).json({ error: err.message });
  }
});

// Forgot password — sends reset email via Zoho SMTP
app.post('/api/auth/forgot-password', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    if(!email) return res.status(400).json({ error: 'Email required' });

    // Check if user exists
    var result = await supabase.from('users').select('id, email').eq('email', email).single();
    
    // Always return success even if email not found (security best practice)
    if(!result.data) {
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    // Generate reset token
    var resetToken = jwt.sign({ id: result.data.id, email: email, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
    var resetUrl = (process.env.APP_URL || 'https://sharpshadowai.com') + '?reset=' + resetToken;

    // Send email via Zoho SMTP
    var nodemailer = require('nodemailer');
    var transporter = nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.ZOHO_EMAIL,
        pass: process.env.ZOHO_PASSWORD
      }
    });

    await transporter.sendMail({
      from: '"Sharp Shadow AI" <' + process.env.ZOHO_EMAIL + '>',
      to: email,
      subject: 'Reset Your Sharp Shadow AI Password',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#020408;color:#e8f4f8;padding:32px">
          <h2 style="color:#00f5ff;font-size:20px;letter-spacing:2px">SHARP SHADOW AI</h2>
          <p style="color:#9ec8d8;font-size:14px;line-height:1.6">You requested a password reset. Click the button below to set a new password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#00f5ff;color:#020408;font-weight:800;padding:14px 32px;text-decoration:none;font-size:14px;letter-spacing:1px;margin:20px 0">RESET MY PASSWORD</a>
          <p style="color:#4a7a8a;font-size:12px">If you didn't request this, ignore this email. Your password won't change.</p>
          <p style="color:#4a7a8a;font-size:12px">Sharp Shadow AI · support@sharpshadowai.com</p>
        </div>
      `
    });

    console.log('PASSWORD RESET EMAIL SENT: ' + email);
    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
  } catch(err) {
    console.log('FORGOT PASSWORD ERROR: ' + err.message);
    res.status(500).json({ error: 'Failed to send reset email. Please contact support@sharpshadowai.com' });
  }
});

// Reset password — called when customer clicks link in email
app.post('/api/auth/reset-password', async function(req, res) {
  try {
    var token = req.body.token || '';
    var password = req.body.password || '';

    if(!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if(password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Verify reset token
    var decoded = jwt.verify(token, JWT_SECRET);
    if(decoded.type !== 'reset') return res.status(400).json({ error: 'Invalid reset token' });

    // Hash new password
    var hash = await bcrypt.hash(password, 10);

    // Update password in database
    var result = await supabase.from('users').update({ password_hash: hash }).eq('id', decoded.id);
    if(result.error) throw result.error;

    console.log('PASSWORD RESET SUCCESS: ' + decoded.email);
    res.json({ success: true, message: 'Password updated successfully. Please log in.' });
  } catch(err) {
    console.log('RESET PASSWORD ERROR: ' + err.message);
    if(err.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Log in
app.post('/api/auth/login', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var password = req.body.password || '';

    if(!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Find user
    var result = await supabase.from('users').select('*').eq('email', email).single();
    if(!result.data) return res.status(401).json({ error: 'No account found with this email. Please sign up first.' });

    var user = result.data;

    // Check subscription status
    if(user.subscription_status === 'cancelled') return res.status(401).json({ error: 'Your subscription has been cancelled. Please resubscribe to continue.' });

    // Verify password
    var valid = await bcrypt.compare(password, user.password_hash);
    if(!valid) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    // Generate JWT token
    var token = jwt.sign({ id: user.id, email: email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });

    console.log('USER LOGIN: ' + email);
    res.json({ success: true, token: token, email: email, plan: user.plan });
  } catch(err) {
    console.log('LOGIN ERROR: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify token (check if still logged in)
app.post('/api/auth/verify', async function(req, res) {
  try {
    var token = req.body.token || '';
    if(!token) return res.status(401).json({ valid: false });
    var decoded = jwt.verify(token, JWT_SECRET);
    // Check subscription status
    var result = await supabase.from('users').select('subscription_status, plan, subscription_end').eq('id', decoded.id).single();
    if(!result.data) return res.json({ valid: false });

    var status = result.data.subscription_status;
    var subEnd = result.data.subscription_end;

    // Allow access if:
    // 1. Status is active or trialing
    // 2. Status is cancelling (cancelled but still within paid period)
    // 3. Status is cancelled BUT subscription_end is in the future (still has paid time left)
    var hasAccess = false;
    if(status === 'active' || status === 'trialing' || status === 'cancelling') {
      hasAccess = true;
    } else if(status === 'cancelled' && subEnd) {
      hasAccess = new Date(subEnd) > new Date();
    }

    if(!hasAccess) return res.json({ valid: false });
    res.json({ valid: true, email: decoded.email, plan: result.data.plan, status: status });
  } catch(err) {
    res.json({ valid: false });
  }
});

// ===== STRIPE WEBHOOK =====
// Must use raw body for Stripe signature verification
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async function(req, res) {
  var sig = req.headers['stripe-signature'];
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  var event;

  try {
    if(!webhookSecret) {
      // No webhook secret set — just parse the event directly
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
    // New subscription started (free trial begins)
    if(event.type === 'checkout.session.completed') {
      var session = event.data.object;
      var email = session.customer_details ? session.customer_details.email : null;
      var customerId = session.customer;
      if(email) {
        await supabase.from('users')
          .update({ stripe_customer_id: customerId, subscription_status: 'active' })
          .eq('email', email.toLowerCase());
        console.log('WEBHOOK: New customer linked - ' + email);
      }
    }

    // Subscription cancelled — keep access until period end
    if(event.type === 'customer.subscription.deleted') {
      var sub = event.data.object;
      var customerId = sub.customer;
      var periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      await supabase.from('users')
        .update({ 
          subscription_status: 'cancelled',
          subscription_end: periodEnd
        })
        .eq('stripe_customer_id', customerId);
      console.log('WEBHOOK: Subscription cancelled - access until ' + periodEnd + ' - customer ' + customerId);
    }

    // Subscription updated (plan change, trial ended, etc)
    if(event.type === 'customer.subscription.updated') {
      var sub = event.data.object;
      var customerId = sub.customer;
      var status = sub.status;
      var periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      // If cancelling at period end (cancel_at_period_end = true), keep active until then
      var dbStatus = 'active';
      if(status === 'trialing') dbStatus = 'active';
      else if(status === 'active') dbStatus = sub.cancel_at_period_end ? 'cancelling' : 'active';
      else if(status === 'past_due') dbStatus = 'past_due';
      else if(status === 'canceled' || status === 'cancelled') dbStatus = 'cancelled';
      await supabase.from('users')
        .update({ subscription_status: dbStatus, subscription_end: periodEnd })
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

// ===== MANAGE SUBSCRIPTION (Stripe Customer Portal) =====
app.post('/api/customer-portal', async function(req, res) {
  try {
    var token = req.body.token || '';
    var decoded = require('jsonwebtoken').verify(token, JWT_SECRET);
    var result = await supabase.from('users').select('stripe_customer_id').eq('id', decoded.id).single();
    if(!result.data || !result.data.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found. Please contact support@sharpshadowai.com' });
    }
    var session = await stripe.billingPortal.sessions.create({
      customer: result.data.stripe_customer_id,
      return_url: process.env.APP_URL || 'https://sharp-shadow-ai-production.up.railway.app'
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
