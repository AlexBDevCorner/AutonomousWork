// Production Supabase -> GitHub review processor. The scheduled ChatGPT reviewer
// supplies the actual code assessment; deterministic code enforces all mutation guards.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { QueueApi, evaluate } from './processor.mjs';
import { findingDescription, isUuid, terminal } from './guards.mjs';

const OWNER = /^AlexBDevCorner\/[A-Za-z0-9_.-]+$/;
const apiRoot = row => {
  if (!OWNER.test(row?.repository ?? '')) throw Error('Unrecognized target repository');
  return '/repos/' + row.repository;
};
const SHA = /^[a-f0-9]{40}$/;
const REASON = /^[a-z0-9_]+$/;
const MAX_BODY = 4000;
const PERSONAL_REVIEWER = 'AlexBDevCorner';
const APP_REVIEWER = 'autonomousworkdispatcher[bot]';
const lower = value => String(value ?? '').toLowerCase();
const TRUSTED_REVIEWERS = new Set([PERSONAL_REVIEWER, APP_REVIEWER].map(lower));
const trustedReviewer = (login, author) =>
  TRUSTED_REVIEWERS.has(lower(login)) && lower(login) !== lower(author);

const result = (status, reason, evidence = {}, extra = {}) => ({status,reason,evidence,...extra});
export const safeReason = e => String(e?.message ?? 'unknown').replace(/https?:\/\/\S+/g,'[url]').slice(0,350);
function asEvidence(decision) {
  return {
    ...(decision.evidence ?? {}),
    guard_reason: decision.reason,
  };
}
function verifyClaim(row,id,clock) {
  if (!row || row.id !== id || row.status !== 'processing' || row.test_only !== false ||
      !OWNER.test(row.repository) || !/^[a-z0-9-]+$/.test(row.project_id) ||
      row.source !== 'chatgpt-scheduled' || !isUuid(row.claim_token) ||
      !Number.isFinite(Date.parse(row.lease_until)) ||
      Date.parse(row.lease_until) <= clock()) throw Error('Invalid live queue claim');
}
function reviewEvent(verdict) {
  return verdict === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'APPROVE';
}
function reviewText(row) {
  // Content comes from the actual AI reviewer, not from deterministic CI guards.
  const summary=typeof row.review_summary==='string' ? row.review_summary.trim() : '';
  if(!summary || summary.length>MAX_BODY)throw Error('Review summary missing or oversized');
  let body='Autonomous review. Reviewed SHA: '+row.reviewed_sha+
    '\n\n'+summary;
  if(row.verdict==='REQUEST_CHANGES') {
    const blocks=row.findings.filter(f=>f && ['P0','P1'].includes(f.severity));
    if(!blocks.length)throw Error('Request changes requires documented blocking findings');
    body+='\n\nBlocking findings:\n'+blocks.map(f=>{
      const where=f.path && f.line ? f.path+':'+f.line : f.location;
      const note=findingDescription(f);
      if(typeof where!=='string' || !where.trim() ||
         typeof note!=='string' || !note.trim())throw Error('Unclear blocking finding');
      return '- ['+f.severity+'] '+where+': '+note;
    }).join('\n');
  }
  if(body.length>12000)throw Error('Review body too large');
  return body;
}
export async function identity(fetcher, token) {
  if(!token)throw Error('Human reviewer PAT missing');
  let response;
  try {
    response=await fetcher('https://api.github.com/user',{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{
        Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','User-Agent':'AutonomousWork-Reviewer',
      },
    });
  } catch { throw Error('Unable to verify human reviewer identity'); }
  if(!response.ok)throw Error('Reviewer identity HTTP '+response.status);
  const user=await response.json();
  if(user?.login!==PERSONAL_REVIEWER)throw Error('PAT is not the configured independent reviewer');
  return user.login;
}
export async function githubWrite({fetcher, token, path, method, body}) {
  if(!token)throw Error('Required GitHub write token missing');
  let response;
  try {
    response=await fetcher('https://api.github.com'+path,{
      method,redirect:'error',signal:AbortSignal.timeout(25000),
      headers:{
        Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','User-Agent':'AutonomousWork-Reviewer',
        'Content-Type':'application/json',
      },
      body:JSON.stringify(body),
    });
  } catch {
    // GitHub may have applied the write before the transport failed.
    throw Error('GitHub '+method+' result uncertain: inspect raw GitHub state before requeueing');
  }
  if(!response.ok)throw Error('GitHub '+method+' HTTP '+response.status+'; inspect GitHub before retrying');
  const value=await response.json();
  return value;
}
export async function submitReview({api,fetcher,token,row,
  expectedReviewer=PERSONAL_REVIEWER,verifyIdentity=expectedReviewer===PERSONAL_REVIEWER}) {
  if(!TRUSTED_REVIEWERS.has(lower(expectedReviewer)))throw Error('Unrecognized review actor');
  const reviewer=verifyIdentity ? await identity(fetcher,token) : expectedReviewer;
  if(!token)throw Error('Review token missing');
  const payload=await githubWrite({
    fetcher,token,path:apiRoot(row)+'/pulls/'+row.pr_number+'/reviews',method:'POST',
    body:{commit_id:row.reviewed_sha,event:reviewEvent(row.verdict),body:reviewText(row)},
  });
  const state=row.verdict==='APPROVE'?'APPROVED':'CHANGES_REQUESTED';
  if(!Number.isSafeInteger(payload.id) || payload.user?.login!==reviewer ||
     payload.commit_id!==row.reviewed_sha || payload.state!==state)
    throw Error('GitHub review response does not match exact head or reviewer');
  // An accepted HTTP response is not enough; independently re-read raw reviews.
  const [reviews,pr]=await Promise.all([
    api.pages(apiRoot(row)+'/pulls/'+row.pr_number+'/reviews'),
    api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number),
  ]);
  if(!reviews.some(r=>r.id===payload.id && r.commit_id===row.reviewed_sha &&
       r.user?.login===reviewer && r.state===state) ||
     pr?.head?.sha!==row.reviewed_sha)
    throw Error('Posted exact-head review cannot be independently confirmed');
  return payload.id;
}
export async function guardedMerge({api,fetcher,token,row,clock,evaluator=evaluate}) {
  // Evaluate MERGE_CHECK freshly, even immediately after our own approval.
  const mergeRow={...row,verdict:'MERGE_CHECK'};
  const before=await evaluator({api,row:mergeRow,now:clock(),live:true});
  if(before.status!=='dry_run' || before.reason!=='merge_guards_passed_no_mutation')
    return { merged:false, decision:before };
  const after=await evaluator({api,row:mergeRow,now:clock(),live:true});
  if(after.status!=='dry_run' || after.reason!=='merge_guards_passed_no_mutation' ||
     after.evidence?.control_sha!==before.evidence?.control_sha)
    return { merged:false, decision:after };
  const pr=await api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number);
  if(pr.state!=='open'||pr.mergeable!==true||pr.head?.sha!==row.reviewed_sha ||
     pr.base?.repo?.full_name!==row.repository)
    return { merged:false, decision:result('stale','head_changed_before_merge') };
  const out=await githubWrite({
    fetcher,token,path:apiRoot(row)+'/pulls/'+row.pr_number+'/merge',method:'PUT',
    body:{sha:row.reviewed_sha,merge_method:'merge'},
  });
  if(out.merged!==true||!SHA.test(out.sha??''))throw Error('GitHub merge response uncertain');
  const confirmed=await api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number);
  if(confirmed?.state!=='closed'||confirmed?.merged!==true ||
     confirmed?.head?.sha!==row.reviewed_sha||confirmed?.merge_commit_sha!==out.sha)
    throw Error('GitHub merge result not independently confirmed');
  return {merged:true,sha:out.sha,reviewId:before.evidence.latest_trusted_review_id};
}
export async function alreadyReviewed({api,row}) {
  const [pr,reviews]=await Promise.all([
    api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number),
    api.pages(apiRoot(row)+'/pulls/'+row.pr_number+'/reviews'),
  ]);
  const want=row.verdict==='APPROVE'?'APPROVED':'CHANGES_REQUESTED';
  const trusted=reviews.filter(r=>trustedReviewer(r.user?.login,pr?.user?.login)&&
    r.commit_id===row.reviewed_sha&&
    ['APPROVED','CHANGES_REQUESTED'].includes(r.state)&&
    Number.isSafeInteger(r.id)&&Number.isFinite(Date.parse(r.submitted_at)));
  trusted.sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at) || a.id-b.id);
  const latest=trusted.at(-1);
  if(!latest || latest.state!==want || pr?.head?.sha!==row.reviewed_sha)
    return null;
  return {pr,reviewId:latest.id};
}
// Idempotent recovery after GitHub accepted a merge but the worker lost the
// database acknowledgement. No second merge request is sent.
export async function alreadyMerged({api,row}) {
  if(!['APPROVE','MERGE_CHECK'].includes(row.verdict)) return null;
  const [pr,reviews]=await Promise.all([
    api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number),
    api.pages(apiRoot(row)+'/pulls/'+row.pr_number+'/reviews'),
  ]);
  if(pr?.state!=='closed'||pr.merged!==true||!SHA.test(pr.merge_commit_sha??'')||
     pr.head?.sha!==row.reviewed_sha||pr.head?.ref!=='autonomous/'+row.task_id||
     pr.head?.repo?.full_name!==row.repository||
     pr.base?.repo?.full_name!==row.repository||!['main','master'].includes(pr.base?.ref)||
     !TRUSTED_REVIEWERS.has(lower(pr.user?.login)))return null;
  const trusted=reviews.filter(r=>trustedReviewer(r.user?.login,pr.user.login)&&
    r.commit_id===row.reviewed_sha&&
    ['APPROVED','CHANGES_REQUESTED'].includes(r.state)&&
    Number.isSafeInteger(r.id)&&Number.isFinite(Date.parse(r.submitted_at)));
  trusted.sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)||a.id-b.id);
  const latest=trusted.at(-1);
  if(latest?.state!=='APPROVED')return null;
  return {mergeSha:pr.merge_commit_sha,reviewId:latest.id};
}
export async function runReviewer({queue,api,reviewerToken,mergeToken,id,
  clock=()=>Date.now(),fetcher=fetch,evaluator=evaluate}) {
  if(!isUuid(id)||!queue||!api)throw Error('Invalid live review dependencies');
  const current=await queue.get(id);
  if(!current)return {outcome:'not_a_live_record'};
  if(terminal(current.status))return {outcome:'duplicate_terminal',status:current.status};
  if(current.status==='processing'&&Date.parse(current.lease_until)>clock())
    return {outcome:'already_processing'};
  const row=await queue.claim(id);
  if(!row)return {outcome:'not_claimed'};
  verifyClaim(row,id,clock);
  let report, reviewId=null, mergeSha=null;
  try {
    const previous=await alreadyMerged({api,row});
    if(previous) {
      report=result('applied','previous_merge_confirmed',{reviewed_sha:row.reviewed_sha});
      reviewId=previous.reviewId;
      mergeSha=previous.mergeSha;
    }
    const before=report ? null : await evaluator({api,row,now:clock(),live:true});
    if(before) report=before;
    const reviewGuardReason = row.verdict === 'REQUEST_CHANGES'
      ? 'blocking_findings_recorded_no_mutation'
      : 'review_guards_passed_no_mutation';
    if(before?.status==='dry_run'&&before.reason===reviewGuardReason &&
       ['APPROVE','REQUEST_CHANGES'].includes(row.verdict)) {
      // Repeat the complete deterministic check immediately before POST.
      const fresh=await evaluator({api,row,now:clock(),live:true});
      if(fresh.status==='dry_run'&&fresh.reason===before.reason &&
         fresh.evidence?.control_sha===before.evidence?.control_sha) {
        const pr=await api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number);
        const useAppReviewer=lower(pr?.user?.login)===lower(PERSONAL_REVIEWER);
        reviewId=await submitReview({
          api,fetcher,row,
          token:useAppReviewer ? mergeToken : reviewerToken,
          expectedReviewer:useAppReviewer ? APP_REVIEWER : PERSONAL_REVIEWER,
          verifyIdentity:!useAppReviewer,
        });
        report=result('applied','review_posted',{reviewed_sha:row.reviewed_sha}, {review_id:reviewId});
      } else report=fresh;
    }
    if(before?.status==='withheld'&&before.reason==='trusted_same_head_verdict_exists'&&
       ['APPROVE','REQUEST_CHANGES'].includes(row.verdict)) {
      // POST may have succeeded on a prior attempt whose acknowledgement failed.
      // Re-read the raw review and resume; never blindly POST a duplicate.
      const existing=await alreadyReviewed({api,row});
      if(existing) {
        reviewId=existing.reviewId;
        report=result('applied','existing_exact_head_review',{reviewed_sha:row.reviewed_sha},
          {review_id:reviewId});
      }
    }
    if((row.verdict==='MERGE_CHECK'&&before?.status==='dry_run'&&
        before.reason==='merge_guards_passed_no_mutation') ||
       (row.verdict==='APPROVE'&&report?.status==='applied')) {
      const merge=await guardedMerge({api,fetcher,token:mergeToken,row,clock,evaluator});
      if(merge.merged) {
        mergeSha=merge.sha;
        reviewId??=merge.reviewId??null;
        report=result('applied','merge_confirmed',{reviewed_sha:row.reviewed_sha},
          {review_id:reviewId,merge_sha:mergeSha});
      } else if(row.verdict==='MERGE_CHECK')report=merge.decision;
      else {
        // The review is a durable useful result even when a fresh merge guard withholds.
        // Record the actual merge decision so an applied APPROVE never looks like a
        // mysterious review_posted row with merge_sha=null.
        report=result('applied','review_posted_merge_withheld',{
          reviewed_sha:row.reviewed_sha,
          merge_guard_status:merge.decision?.status??'unknown',
          merge_guard_reason:merge.decision?.reason??'unknown',
          merge_guard_evidence:merge.decision?.evidence??{},
        },{review_id:reviewId});
      }
    }
    if(!report||!['applied','stale','withheld','failed'].includes(report.status)||
       !REASON.test(report.reason??''))throw Error('Unexpected review guard decision');
  } catch(error) {
    // Do not claim an uncertain review/merge failed definitively. A retry MUST
    // check GitHub's raw persisted reviews first. Keep evidence bounded.
    try {
      await queue.finish(id,row.claim_token,
        result('retryable','downstream_result_uncertain',{error:'inspect_github_and_retry'}));
    } catch { /* expired claim: leave for bounded recovery, do not force complete */ }
    throw error;
  }
  const evidence=asEvidence(report);
  const completion={
    status:report.status,reason:report.reason,evidence,
    ...(report.status==='applied'?{review_id:reviewId,merge_sha:mergeSha}:{}),
  };
  await queue.finish(id,row.claim_token,completion);
  return {outcome:'processed',...completion};
}
export function assertEnvironment(env) {
  if(env.GITHUB_REPOSITORY!=='AlexBDevCorner/AutonomousWork'||
      env.GITHUB_REF!=='refs/heads/master'||env.AUTONOMOUS_REVIEW_ENABLED!=='true'||
      !isUuid(env.QUEUE_ID)||!env.READ_GH_TOKEN||!env.MERGE_GH_TOKEN||
      !env.AUTONOMOUS_REVIEWER_TOKEN||
      !env.REVIEW_BRIDGE_QUEUE_TOKEN||env.REVIEW_BRIDGE_QUEUE_TOKEN.length<32)
    throw Error('Autonomous review disabled or required credentials missing');
}
async function main() {
  assertEnvironment(process.env);
  const env=process.env;
  const out=await runReviewer({
    queue:new QueueApi(env.REVIEW_BRIDGE_QUEUE_TOKEN,fetch,'live'),
    api:new GitHub(env.READ_GH_TOKEN),
    reviewerToken:env.AUTONOMOUS_REVIEWER_TOKEN,
    mergeToken:env.MERGE_GH_TOKEN,
    id:env.QUEUE_ID,
  });
  console.info('Autonomous reviewer:',out.outcome,out.status??'',out.reason??'',env.QUEUE_ID);
  if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,
    '### Autonomous review\n- Queue: '+env.QUEUE_ID+
    '\n- Outcome: '+out.outcome+'\n- Status: '+(out.status??'none')+
    '\n- Reason: '+(out.reason??'none')+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error('Autonomous reviewer stopped:',safeReason(e));process.exitCode=1;});
