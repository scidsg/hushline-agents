const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {generateVerifiedUserCopy} = require('../scripts/render-verified-user-post');
const {normalizeVerifiedUsers, buildVerifiedUserSocialParagraphs} = require('../scripts/lib/verified-user-post');
const selectedUser = normalizeVerifiedUsers([{display_name:'Test Reporter', primary_username:'test-reporter', bio:'Investigative reporter covering public spending.', is_verified:true, entry_type:'user'}], 'https://tips.hushline.app')[0];
const run = {date:'2026-09-25', selectedUser};
const copy = buildVerifiedUserSocialParagraphs(selectedUser);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  return dir;
}

test('saves validated final JSON even when Codex never edits copy.json', t => {
  const dir = fixture(t);
  const result = generateVerifiedUserCopy(run, dir, {spawn(command,args,options) {
    if(command === 'which') return {status:0};
    assert.equal(args[args.indexOf('--sandbox')+1], 'read-only');
    assert.ok(!args.includes('--full-auto'));
    assert.match(options.input, /Return only the JSON object/);
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));
    assert.deepEqual(schema.required, ['linkedin','mastodon','bluesky']);
    assert.equal(fs.existsSync(path.join(dir,'copy.json')),false);
    fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(copy));
    return {status:0};
  }});
  assert.equal(result.fallback,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.copyPath)),copy);
  assert.equal(fs.readdirSync(dir).some(n=>n.startsWith('.copy-response-')),false);
});

test('retries invalid output and saves the valid second response', t => {
  const dir=fixture(t);let calls=0;
  const result=generateVerifiedUserCopy(run,dir,{spawn(command,args) {
    if(command==='which') return {status:0};
    fs.writeFileSync(args[args.indexOf('-o')+1],++calls===1 ? '{}' : JSON.stringify(copy));
    return {status:0};
  }});
  assert.equal(calls,2);assert.equal(result.fallback,false);
});

test('retains fallback after failed generation and removes temporary responses', t => {
  const dir=fixture(t);
  const result=generateVerifiedUserCopy(run,dir,{spawn(command) {
    return command==='which' ? {status:0} : {status:1,stderr:'synthetic private transcript'};
  }});
  assert.equal(result.fallback,true);
  assert.equal(fs.readdirSync(dir).some(n=>n.startsWith('.copy-response-')),false);
  assert.ok(fs.existsSync(result.copyPath));
});
