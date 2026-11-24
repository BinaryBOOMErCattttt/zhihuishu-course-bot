'use strict';
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
const { Bot } = require(path.join(root, 'lib', 'bot.js'));

const cfgPath = path.join(root, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
let state = { completed: [], forcePending: [] };
try { state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state.json'), 'utf8')); } catch {}

const bot = new Bot({ rootDir: root, config, state, onEvent: () => {} });
const timerPath = path.join(root, 'data', 'timer.json');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

let t = { date: today, seconds: 1499, limit: 1500, notified: false };
fs.writeFileSync(timerPath, JSON.stringify(t, null, 2));

let threw = false;
try { bot.addWatchTime(1); } catch (e) { threw = e.code === 'DAILY_LIMIT'; }
const after = JSON.parse(fs.readFileSync(timerPath, 'utf8'));

let secondAllowed = false;
try { bot.addWatchTime(1); secondAllowed = true; } catch { secondAllowed = false; }
const final = JSON.parse(fs.readFileSync(timerPath, 'utf8'));

fs.writeFileSync(timerPath, JSON.stringify({ date: today, seconds: 0, limit: 1500, notified: false }, null, 2));

console.log(JSON.stringify({ threw, notified: after.notified, secondAllowed, seconds: final.seconds }));
process.exit(threw && after.notified && secondAllowed ? 0 : 1);
