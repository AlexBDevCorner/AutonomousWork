import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord } from './guards.mjs';
import { QueueApi } from './processor.mjs';
import { assertEnvironment, alreadyMerged, guardedMerge, runReviewer,
  submitReview } from './reviewer.mjs';

const id='f8369c6d-9360-4dd0-a5d3-54a229e92a00';
const sha='a'.repeat(40), mergeSha='b'.repeat(40), controlSha='c'.repeat(40);
const makeRow=(verdict='REQUEST_CHANGES')=>({
  id,schema_version:1,source:'chatgpt-scheduled',
  repository:'AlexBDevCorner/MtgSoloSports',project_id:'mtgsolosports',
  task_id:'MSS-002',pr_number:4,reviewed_sha:sha,verdict,findings:
    verdict==='REQUEST_CHANGES'?[{severity:'P1',path:'src/Foo.cs',line:42,
      description:'Reproducible broken versioned rule snapshot.'}]:[],
  ci:{'build-and-test':'success'},review_summary:'Checked against MSS-002. No fabricated review.',
  observed_at:new Date().toISOString(),test_only:false,status:'processing',attempts:1,
  claim_token:id,lease_until:new Date(Date.now()+10*60_000).toISOString(),
});
const pr=(overrides={})=>({
  number:4,state:'open',draft:false,merged:false,mergeable:true,
  user:{login:'autonomousworkdispatcher[bot]'},
  head:{sha,ref:'autonomous/MSS-002',repo:{full_name:'AlexBDevCorner/MtgSoloSports'}},
  base:{ref:'main',repo:{full_name:'AlexBDevCorner/MtgSoloSports'}},
  ...overrides,
});
const completedReview=(state='APPROVED',reviewer='AlexBDevCorner')=>({
  id:999,commit_id:sha,user:{login:reviewer},
  state,submitted_at:new Date().toISOString(),
});
const apiMock=({initialPr=pr(),initialReviews=[]}={})=>{
  let p=initialPr;const reviews=[...initialReviews];
  const api={
    request:async (method,path)=>{
      assert.equal(method,'GET');
      if(path.endsWith('/pulls/4'))return p;
      throw Error('Unrecognized test GET '+path);
    },
    pages:async path=>{
      if(path.endsWith('/pulls/4/reviews'))return [...reviews];
      throw Error('Unrecognized test pages '+path);
    },
  };
  return {api,reviews,replacePr:value=>{p=value;}};
};
const evaluator=async ({row})=>({
  status:'dry_run',reason:row.verdict==='MERGE_CHECK'
    ? 'merge_guards_passed_no_mutation'
    : row.verdict==='REQUEST_CHANGES'
      ? 'blocking_findings_recorded_no_mutation' : 'review_guards_passed_no_mutation',
  evidence:{control_sha:controlSha,latest_trusted_review_id:999},
});
function queueMock(row) {
  const finishes=[];return {
    finishes,
    get:async ()=>({...row,status:'queued',lease_until:null}),
    claim:async ()=>row,
    finish:async (...args)=>{finishes.push(args);},
  };
}
function writeMock(mock) {
  const calls=[];const fetcher=async (url,options)=>{
    calls.push({url,method:options.method,auth:options.headers?.Authorization,body:options.body?JSON.parse(options.body):null});
    if(url.endsWith('/user'))return {ok:true,json:async()=>({login:'AlexBDevCorner'})};
    if(url.endsWith('/pulls/4/reviews')){
      const actor=options.headers?.Authorization==='Bearer app'
        ? 'autonomousworkdispatcher[bot]' : 'AlexBDevCorner';
      mock.reviews.push(completedReview(
        JSON.parse(options.body).event==='APPROVE'?'APPROVED':'CHANGES_REQUESTED',actor));
      return {ok:true,json:async()=>mock.reviews.at(-1)};
    }
    if(url.endsWith('/pulls/4/merge')){
      mock.replacePr(pr({state:'closed',merged:true,merge_commit_sha:mergeSha}));
      return {ok:true,json:async()=>({merged:true,sha:mergeSha})};
    }
    throw Error('Unexpected test write '+url);
  };
  return {calls,fetcher};
}

test('Step 3 rejects non-test rows; live review accepts only its own real rows',()=>{
  const row=makeRow();
  assert.equal(validateRecord(row,id,Date.now()),'production_verdicts_not_enabled');
  assert.equal(validateRecord(row,id,Date.now(),true),null);
  assert.equal(validateRecord({...row,repository:'AlexBDevCorner/RepoManager'},id,Date.now(),true),null);
  assert.equal(validateRecord({...row,test_only:true},id,Date.now(),true),
    'outside_live_review_scope');
});

test('live QueueApi explicitly opts into server-side reviewed record mode',async()=>{
  const calls=[];const fetcher=async (url,options)=>{
    calls.push({url:String(url),options});
    if(options.method==='GET')return {ok:true,status:200,json:async()=>({row:{id}})};
    return {ok:true,status:200,json:async()=>({claimed:false})};
  };
  const api=new QueueApi('x'.repeat(64),fetcher,'live');
  await api.get(id);await api.claim(id);
  assert.match(calls[0].url,/mode=live/);
  assert.equal(JSON.parse(calls[1].options.body).mode,'live');
  assert.ok(!calls[1].options.body.includes('sb_secret_'));
});

test('hard write flag prevents starting the live reviewer',()=>{
  assert.throws(()=>assertEnvironment({
    GITHUB_REPOSITORY:'AlexBDevCorner/AutonomousWork',GITHUB_REF:'refs/heads/master',
    AUTONOMOUS_REVIEW_ENABLED:'false',QUEUE_ID:id,
    READ_GH_TOKEN:'read',MERGE_GH_TOKEN:'merge',
    AUTONOMOUS_REVIEWER_TOKEN:'human',REVIEW_BRIDGE_QUEUE_TOKEN:'x'.repeat(64),
  }),/disabled/);
});

test('actual REQUEST_CHANGES POST uses its exact head and never merges',async()=>{
  const row=makeRow(),mock=apiMock();
  const q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  assert.equal(done.review_id,999);
  assert.equal(done.merge_sha,null);
  const review=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.equal(review.body.event,'REQUEST_CHANGES');
  assert.equal(review.body.commit_id,sha);
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
  assert.equal(q.finishes.length,1);
});

test('scheduled location + explanation P1 is included in the submitted GitHub review',async()=>{
  const row=makeRow();
  row.findings=[{
    severity:'P1',path:'src/MtgSoloSports/Persistence/Saves/SaveStore.cs',
    location:'OpenDbContext(Guid saveId)',
    explanation:'Existing saves fail because the new Stages/Rounds migration is never applied.',
  }];
  const mock=apiMock(),q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  const review=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.equal(review.body.event,'REQUEST_CHANGES');
  assert.equal(review.body.commit_id,sha);
  assert.match(review.body.body,/Existing saves fail because the new Stages\/Rounds migration is never applied/);
  assert.match(review.body.body,/OpenDbContext\(Guid saveId\)/);
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
});

test('reproduction plus consequence P1 posts the full explanation',async()=>{
  const row=makeRow();
  row.findings=[{
    severity:'P1',path:'src/Qualifier.cs',location:'RunUnderLockAsync',
    title:'Wrong qualifier roster',reproduction:'A challenger wins but stays in a feeder.',
    consequence:'The next Superleague roster ignores qualifier results.',
  }];
  const mock=apiMock(),q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  const review=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.match(review.body.body,/A challenger wins but stays in a feeder/);
  assert.match(review.body.body,/Consequence: The next Superleague roster ignores qualifier results/);
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
});

test('a real APPROVE POST is followed by fresh independent guarded GitHub merge',async()=>{
  const row=makeRow('APPROVE'),mock=apiMock(),q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  assert.equal(done.merge_sha,mergeSha);
  assert.equal(done.review_id,999);
  assert.equal(writes.calls.find(c=>c.url.endsWith('/merge')).body.sha,sha);
  assert.equal(writes.calls.find(c=>c.url.endsWith('/merge')).body.merge_method,'merge');
});

test('an applied APPROVE records the fresh merge guard reason when merge is withheld',async()=>{
  const row=makeRow('APPROVE'),mock=apiMock(),q=queueMock(row),writes=writeMock(mock);
  const blockedEvaluator=async ({row:observed})=>observed.verdict==='MERGE_CHECK'
    ? {status:'withheld',reason:'merge_requires_green_ci',
      evidence:{control_sha:controlSha,ci:'pending',latest_trusted_review_id:999}}
    : evaluator({row:observed});
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator:blockedEvaluator});
  assert.equal(done.status,'applied');
  assert.equal(done.reason,'review_posted_merge_withheld');
  assert.equal(done.review_id,999);
  assert.equal(done.merge_sha,null);
  assert.equal(done.evidence.merge_guard_status,'withheld');
  assert.equal(done.evidence.merge_guard_reason,'merge_requires_green_ci');
  assert.equal(done.evidence.merge_guard_evidence.ci,'pending');
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
  assert.equal(q.finishes.length,1);
});

test('a manually authored PR is reviewed by the worker App, never by its author',async()=>{
  const row=makeRow('APPROVE');
  const manualPr=pr({user:{login:'AlexBDevCorner'}});
  const mock=apiMock({initialPr:manualPr}),q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  assert.equal(done.merge_sha,mergeSha);
  const review=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.equal(review.auth,'Bearer app');
  assert.equal(mock.reviews.at(-1).user.login,'autonomousworkdispatcher[bot]');
  assert.equal(writes.calls.some(c=>c.url.endsWith('/user')&&c.auth==='Bearer app'),false);
});

test('a lost merge acknowledgement recovers from existing GitHub approval and merge',async()=>{
  const row=makeRow('MERGE_CHECK');
  const mock=apiMock({initialPr:pr({state:'closed',merged:true,merge_commit_sha:mergeSha}),
    initialReviews:[completedReview()]});
  const q=queueMock(row);
  const done=await runReviewer({queue:q,api:mock.api,
    reviewerToken:'human',mergeToken:'app',id,
    fetcher:()=>{throw Error('No duplicate writes allowed');},
    evaluator:()=>{throw Error('Do not re-evaluate an already merged PR');}});
  assert.equal(done.reason,'previous_merge_confirmed');
  assert.equal(done.merge_sha,mergeSha);
  assert.equal(q.finishes.length,1);
});

test('an earlier same-head approval does not override a newer trusted change request',async()=>{
  const row=makeRow('APPROVE');
  const old=completedReview('APPROVED');
  const newer={...completedReview('CHANGES_REQUESTED'),id:1000,
    submitted_at:new Date(Date.now()+1000).toISOString()};
  const mock=apiMock({initialReviews:[old,newer]});
  let writes=0;
  const q=queueMock(row);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:()=>{writes++;throw Error('Unsafe write');},
    evaluator:async()=>({status:'withheld',reason:'trusted_same_head_verdict_exists'})});
  assert.equal(writes,0);
  assert.equal(done.status,'withheld');
});

test('MERGE_CHECK without latest trusted approval cannot call the merge API',async()=>{
  const row=makeRow('MERGE_CHECK'),mock=apiMock();
  let calls=0;
  const status=await guardedMerge({api:mock.api,row,token:'app',
    fetcher:async()=>{calls++;throw Error('Unsafe merge');},clock:()=>Date.now(),
    evaluator:async()=>({status:'withheld',reason:'merge_requires_latest_same_head_trusted_approval'})});
  assert.equal(status.merged,false);
  assert.equal(calls,0);
});


test('same permanent reviewer handles a second enrolled repository without alternate code paths',async()=>{
  const row={...makeRow(),repository:'AlexBDevCorner/RepoManager',project_id:'repomanager',task_id:'RM-008'};
  const other=pr({
    head:{sha,ref:'autonomous/RM-008',repo:{full_name:'AlexBDevCorner/RepoManager'}},
    base:{ref:'master',repo:{full_name:'AlexBDevCorner/RepoManager'}},
  });
  const mock=apiMock({initialPr:other}),q=queueMock(row),writes=writeMock(mock);
  const done=await runReviewer({queue:q,api:mock.api,reviewerToken:'human',
    mergeToken:'app',id,fetcher:writes.fetcher,evaluator});
  assert.equal(done.status,'applied');
  assert.equal(done.review_id,999);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.ok(sent.url.includes('/repos/AlexBDevCorner/RepoManager/'));
  assert.equal(sent.body.commit_id,sha);
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
});
