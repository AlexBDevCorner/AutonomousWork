// Guarded GitHub review and merge writers. The OpenCode reviewer supplies the code
// assessment; deterministic code enforces every mutation guard and confirms each write.
import { evaluate } from './processor.mjs';
import { findingDescription } from './guards.mjs';

const OWNER = /^AlexBDevCorner\/[A-Za-z0-9_.-]+$/;
const apiRoot = row => {
  if (!OWNER.test(row?.repository ?? '')) throw Error('Unrecognized target repository');
  return '/repos/' + row.repository;
};
const SHA = /^[a-f0-9]{40}$/;
const MAX_BODY = 4000;
const PERSONAL_REVIEWER = 'AlexBDevCorner';
const APP_REVIEWER = 'autonomousworkdispatcher[bot]';
const lower = value => String(value ?? '').toLowerCase();
const TRUSTED_REVIEWERS = new Set([PERSONAL_REVIEWER, APP_REVIEWER].map(lower));

const result = (status, reason, evidence = {}, extra = {}) => ({status,reason,evidence,...extra});
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
// The independent reviewer must not be the PR author: the personal reviewer token normally,
// the worker App for PRs the personal account authored (manual recovery PRs).
export async function postReview({api,fetcher,row,reviewerToken,appToken}) {
  const pr=await api.request('GET',apiRoot(row)+'/pulls/'+row.pr_number);
  const useAppReviewer=lower(pr?.user?.login)===lower(PERSONAL_REVIEWER);
  return submitReview({
    api,fetcher,row,
    token:useAppReviewer ? appToken : reviewerToken,
    expectedReviewer:useAppReviewer ? APP_REVIEWER : PERSONAL_REVIEWER,
    verifyIdentity:!useAppReviewer,
  });
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
