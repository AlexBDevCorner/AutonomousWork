// Trusted-master, manual-only Step 5 fixture checks and guarded PR mutation.
// Never use this file in repository_dispatch or for production autonomous PRs.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { MERGE_FIXTURE as F, evaluateFixture, isSha } from './merge-fixture-guards.mjs';

const ROOT = '/repos/' + F.repo;
const SHA = /^[a-f0-9]{40}$/;
const CONFIRM_APPROVE = 'STEP5_FIXTURE_APPROVE';
const CONFIRM_MERGE = 'STEP5_ISOLATED_FIXTURE_MERGE';

function decode(file) {
  if (file?.encoding !== 'base64' || !isSha(file.sha) ||
      typeof file.content !== 'string') throw Error('Missing or malformed trusted control file');
  return Buffer.from(file.content, 'base64').toString('utf8');
}
function one(prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw Error('Missing fixture PR number');
  return prNumber;
}

export async function fixtureSnapshot({ api, number, sha, action }) {
  one(number);
  if (!isSha(sha)) throw Error('Expected SHA must be exactly 40 hexadecimal characters');
  const master = await api.request('GET', ROOT+'/git/ref/heads/master');
  const controlSha = master?.object?.sha;
  if (!SHA.test(controlSha ?? '')) throw Error('Unable to pin control master');
  const [configFile, protocolFile] = await Promise.all([
    api.request('GET',ROOT+'/contents/automation/config.json?ref='+controlSha),
    api.request('GET',ROOT+'/contents/reviewer/CHATGPT_REVIEW.md?ref='+controlSha),
  ]);
  const config = JSON.parse(decode(configFile));
  // Always read actual PR rather than trusting event payload or supplied branch.
  const pr = await api.request('GET',ROOT+'/pulls/'+number);
  const [target, files, openPrs, checks, reviews] = await Promise.all([
    api.request('GET',ROOT+'/git/ref/heads/'+F.target),
    api.pages(ROOT+'/pulls/'+number+'/files'),
    api.pages(ROOT+'/pulls?state=open'),
    api.pages(ROOT+'/commits/'+sha+'/check-runs','check_runs'),
    api.pages(ROOT+'/pulls/'+number+'/reviews'), // raw GitHub REST commit_id
  ]);
  // The file path is fixed, requested by exact expected head commit only.
  let fixtureText = null;
  if (pr?.head?.ref === F.head && pr?.head?.sha === sha &&
      files.length === 1 && files[0]?.filename === F.file) {
    const file = await api.request('GET',ROOT+'/contents/'+F.file+'?ref='+sha);
    fixtureText = decode(file);
  }
  const targetSha = target?.object?.sha;
  const decision = evaluateFixture({
    config, protocolSha:protocolFile.sha, masterSha:controlSha, pr, openPrs,
    files, fixtureText, checks, reviews, targetSha, expectedSha:sha, action,
  });
  return { decision, controlSha, targetSha, number, sha, action };
}

function sameEvidence(a,b) {
  if (a.controlSha !== b.controlSha || a.targetSha !== b.targetSha ||
      a.sha !== b.sha || a.number !== b.number)
    throw Error('Control, target or head changed while validating; no mutation');
}

export async function guardBeforeWrite({ api, number, sha, action }) {
  const first = await fixtureSnapshot({ api, number, sha, action });
  const eligible = action === 'APPROVE' ? 'eligible_approve' : 'eligible_merge';
  if (first.decision.outcome !== eligible) return first.decision;
  const fresh = await fixtureSnapshot({ api, number, sha, action });
  sameEvidence(first,fresh);
  if (fresh.decision.outcome !== eligible) return fresh.decision;
  // A final live ref check directly before the mutation closes the gap between snapshots.
  const [control, target, pr] = await Promise.all([
    api.request('GET',ROOT+'/git/ref/heads/master'),
    api.request('GET',ROOT+'/git/ref/heads/'+F.target),
    api.request('GET',ROOT+'/pulls/'+number),
  ]);
  if (control?.object?.sha !== fresh.controlSha ||
      target?.object?.sha !== fresh.targetSha ||
      pr?.head?.sha !== sha || pr?.state !== 'open' ||
      pr?.base?.sha !== fresh.targetSha || pr?.mergeable !== true)
    throw Error('Live control, target or PR changed immediately before write');
  return fresh.decision;
}

async function requestWrite({ fetcher, token, path, method, body, expectedStatus }) {
  if (!token) throw Error('Dedicated write credential missing');
  let response;
  try {
    response = await fetcher('https://api.github.com'+path,{
      method,redirect:'error',signal:AbortSignal.timeout(25000),
      headers:{
        Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','User-Agent':'AutonomousWork-Step5-Isolated',
        'Content-Type':'application/json',
      },
      body:JSON.stringify(body),
    });
  } catch {
    // A successful remote write may precede a local timeout. NEVER blindly retry.
    throw Error(method+' outcome uncertain; inspect GitHub PR/reviews before trying again');
  }
  if (!response.ok || !expectedStatus.includes(response.status))
    throw Error(method+' failed with HTTP '+response.status+'; inspect GitHub before retrying');
  try { return await response.json(); }
  catch { throw Error(method+' returned ambiguous body; inspect live GitHub before retrying'); }
}

export async function submitFixtureApproval({ fetcher, token, number, sha }) {
  one(number);
  if (!isSha(sha)) throw Error('Invalid SHA');
  const review = await requestWrite({
    fetcher,token,path:ROOT+'/pulls/'+number+'/reviews',method:'POST',
    body:{
      commit_id:sha,event:'APPROVE',
      body:'Isolated Step 5 fixture only. Reviewed SHA: '+sha+
        '\nBoth exact-head fixture-validation and validate checks passed. '+
        'This approval cannot authorize any production autonomous task.',
    },
    expectedStatus:[200],
  });
  if (!Number.isSafeInteger(review.id) || review.user?.login !== F.reviewer ||
      review.commit_id !== sha || review.state !== 'APPROVED')
    throw Error('Returned approval review ID, author, SHA or state mismatch; inspect GitHub');
  return { id:review.id, sha:review.commit_id, state:review.state };
}

export async function submitFixtureMerge({ fetcher, token, number, sha }) {
  one(number);
  if (!isSha(sha)) throw Error('Invalid SHA');
  const result = await requestWrite({
    fetcher,token,path:ROOT+'/pulls/'+number+'/merge',method:'PUT',
    body:{ sha, merge_method:'merge',
      commit_title:'Merge isolated Step 5 fixture PR (never master)' },
    expectedStatus:[200,201],
  });
  if (result.merged !== true || !isSha(result.sha))
    throw Error('GitHub merge response lacks confirmed merge SHA; inspect manually');
  return { merged:true, sha:result.sha };
}

async function reviewerIdentity({ fetcher, token }) {
  if (!token) throw Error('Dedicated reviewer PAT missing');
  const url='https://api.github.com/user';
  const response=await fetcher(url,{
    method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','User-Agent':'AutonomousWork-Step5-Isolated'},
  });
  if (!response.ok) throw Error('Unable to verify reviewer identity');
  const user=await response.json();
  if(user.login!==F.reviewer)throw Error('Reviewer token is not the trusted human');
  return user.login;
}

export async function execute({ api, number, sha, mode, approveToken,
  mergeToken, enabled = false, confirmation = '', fetcher=fetch }) {
  if (!['VERIFY_ONLY','APPROVE','MERGE_CHECK','MERGE'].includes(mode))
    throw Error('Unsupported isolated fixture operation');
  // No token or enablement can change the hardcoded fixture scope.
  if (mode === 'VERIFY_ONLY' || mode === 'MERGE_CHECK') {
    const result=await fixtureSnapshot({api,number,sha,action:mode});
    return result.decision;
  }
  const writer= mode==='APPROVE' ? approveToken : mergeToken;
  const confirm=mode==='APPROVE' ? CONFIRM_APPROVE : CONFIRM_MERGE;
  if(!enabled || !writer || confirmation!==confirm)
    throw Error('Step 5 fixture writes are disabled or explicit confirmation missing');
  if(mode==='APPROVE') await reviewerIdentity({fetcher,token:writer});
  const before=await guardBeforeWrite({api,number,sha,action:mode});
  if(mode==='APPROVE' && before.outcome==='already_reviewed')return before;
  if(mode==='MERGE' && before.outcome==='already_merged')return before;
  if(before.outcome!==(mode==='APPROVE'?'eligible_approve':'eligible_merge'))
    return before;
  if(mode==='APPROVE') {
    const review=await submitFixtureApproval({fetcher,token:writer,number,sha});
    const [reviews,pr]=await Promise.all([
      api.pages(ROOT+'/pulls/'+number+'/reviews'),api.request('GET',ROOT+'/pulls/'+number),
    ]);
    if(!reviews.some(r=>r.id===review.id && r.user?.login===F.reviewer &&
         r.state==='APPROVED' && r.commit_id===sha) || pr?.head?.sha!==sha)
      throw Error('Exact-head approval not confirmed on fresh GitHub read');
    return {outcome:'approved',...review};
  }
  const merged=await submitFixtureMerge({fetcher,token:writer,number,sha});
  const [pr,target]=await Promise.all([
    api.request('GET',ROOT+'/pulls/'+number),
    api.request('GET',ROOT+'/git/ref/heads/'+F.target),
  ]);
  if(pr?.merged!==true || pr?.state!=='closed' || pr?.head?.sha!==sha ||
      pr?.base?.ref!==F.target || pr?.merge_commit_sha!==merged.sha ||
      target?.object?.sha!==merged.sha)
    throw Error('Exact fixture merge response was not confirmed by fresh PR and target branch; inspect manually');
  return {outcome:'merged',merge_sha:merged.sha,head:sha,number};
}

export function assertRuntime(env) {
  if(env.GITHUB_REPOSITORY!==F.repo || env.GITHUB_REF!=='refs/heads/master' ||
     env.GITHUB_EVENT_NAME!=='workflow_dispatch')
    throw Error('Manual trusted master workflow required');
  if(!/^[1-9]\d{0,7}$/.test(env.STEP5_PR??'') || !isSha(env.STEP5_SHA) ||
      !['VERIFY_ONLY','APPROVE','MERGE_CHECK','MERGE'].includes(env.STEP5_MODE))
    throw Error('Expected exact fixture PR, SHA and action');
  if(!env.READ_ONLY_GITHUB_TOKEN)throw Error('Read-only GitHub token required');
  if(['APPROVE','MERGE'].includes(env.STEP5_MODE)) {
    if (env.STEP5_ENABLED!=='true')throw Error('Independent fixture-only write gate is off');
    if (env.STEP5_MODE==='APPROVE' &&
       (!env.REVIEW_BRIDGE_REVIEWER_TOKEN || env.STEP5_CONFIRM!==CONFIRM_APPROVE))
      throw Error('Explicit dedicated human approval credentials/confirmation required');
    if (env.STEP5_MODE==='MERGE' &&
       (!env.STEP5_MERGE_TOKEN || env.STEP5_CONFIRM!==CONFIRM_MERGE))
      throw Error('Explicit isolated merge App token/confirmation required');
  }
}

async function main() {
  const env=process.env;assertRuntime(env);
  const result=await execute({
    api:new GitHub(env.READ_ONLY_GITHUB_TOKEN),number:Number(env.STEP5_PR),
    sha:env.STEP5_SHA,mode:env.STEP5_MODE,
    approveToken:env.REVIEW_BRIDGE_REVIEWER_TOKEN,
    mergeToken:env.STEP5_MERGE_TOKEN,
    enabled:env.STEP5_ENABLED==='true',confirmation:env.STEP5_CONFIRM,
  });
  console.log('Step 5 isolated fixture:', result.outcome, result.reason??'',
    result.head??result.sha??'',result.merge_sha??'');
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,
    '### Step 5 isolated fixture\n\n'+
    '- Mode: '+env.STEP5_MODE+'\n- PR: '+env.STEP5_PR+'\n- Expected SHA: '+env.STEP5_SHA+
    '\n- Outcome: '+result.outcome+'\n- No production autonomous task or Supabase queue involved.\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error('Step 5 stopped:',String(e?.message??'unknown').replace(/https?:\/\/\S+/g,'[url]'));process.exitCode=1;});
