import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord } from './guards.mjs';
import { guardedMerge, postReview } from './reviewer.mjs';

const id='f8369c6d-9360-4dd0-a5d3-54a229e92a00';
const sha='a'.repeat(40), mergeSha='b'.repeat(40), controlSha='c'.repeat(40);
const makeRow=(verdict='REQUEST_CHANGES')=>({
  id,schema_version:1,source:'opencode-actions',
  repository:'AlexBDevCorner/MtgSoloSports',project_id:'mtgsolosports',
  task_id:'MSS-002',pr_number:4,reviewed_sha:sha,verdict,findings:
    verdict==='REQUEST_CHANGES'?[{severity:'P1',path:'src/Foo.cs',line:42,
      description:'Reproducible broken versioned rule snapshot.'}]:[],
  ci:{'build-and-test':'success'},review_summary:'Checked against MSS-002. No fabricated review.',
  observed_at:new Date().toISOString(),test_only:false,status:'processing',
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
const review=(row,mock,writes)=>postReview({api:mock.api,fetcher:writes.fetcher,row,reviewerToken:'human',appToken:'app'});
const merge=(row,mock,writes,evaluate=evaluator)=>guardedMerge({api:mock.api,fetcher:writes.fetcher,token:'app',
  row:{...row,verdict:'MERGE_CHECK'},clock:()=>Date.now(),evaluator:evaluate});

test('live review rows are accepted only outside test scope',()=>{
  const row=makeRow();
  assert.equal(validateRecord(row,id,Date.now()),'production_verdicts_not_enabled');
  assert.equal(validateRecord(row,id,Date.now(),true),null);
  assert.equal(validateRecord({...row,repository:'AlexBDevCorner/RepoManager'},id,Date.now(),true),null);
  assert.equal(validateRecord({...row,test_only:true},id,Date.now(),true),
    'outside_live_review_scope');
});

test('actual REQUEST_CHANGES POST uses its exact head and never merges',async()=>{
  const row=makeRow(),mock=apiMock(),writes=writeMock(mock);
  assert.equal(await review(row,mock,writes),999);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.equal(sent.body.event,'REQUEST_CHANGES');
  assert.equal(sent.body.commit_id,sha);
  assert.equal(sent.auth,'Bearer human');
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
});

test('location + explanation P1 is included in the submitted GitHub review',async()=>{
  const row=makeRow();
  row.findings=[{
    severity:'P1',path:'src/MtgSoloSports/Persistence/Saves/SaveStore.cs',
    location:'OpenDbContext(Guid saveId)',
    explanation:'Existing saves fail because the new Stages/Rounds migration is never applied.',
  }];
  const mock=apiMock(),writes=writeMock(mock);
  await review(row,mock,writes);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.match(sent.body.body,/Existing saves fail because the new Stages\/Rounds migration is never applied/);
  assert.match(sent.body.body,/OpenDbContext\(Guid saveId\)/);
});

test('reproduction plus consequence P1 posts the full explanation',async()=>{
  const row=makeRow();
  row.findings=[{
    severity:'P1',path:'src/Qualifier.cs',location:'RunUnderLockAsync',
    title:'Wrong qualifier roster',reproduction:'A challenger wins but stays in a feeder.',
    consequence:'The next Superleague roster ignores qualifier results.',
  }];
  const mock=apiMock(),writes=writeMock(mock);
  await review(row,mock,writes);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.match(sent.body.body,/A challenger wins but stays in a feeder/);
  assert.match(sent.body.body,/Consequence: The next Superleague roster ignores qualifier results/);
});

test('a real APPROVE POST is followed by fresh independent guarded GitHub merge',async()=>{
  const row=makeRow('APPROVE'),mock=apiMock(),writes=writeMock(mock);
  assert.equal(await review(row,mock,writes),999);
  const merged=await merge(row,mock,writes);
  assert.deepEqual([merged.merged,merged.sha],[true,mergeSha]);
  const sent=writes.calls.find(c=>c.url.endsWith('/merge'));
  assert.equal(sent.body.sha,sha);
  assert.equal(sent.body.merge_method,'merge');
});

test('a withheld merge guard reports its reason and never calls the merge API',async()=>{
  const row=makeRow('APPROVE'),mock=apiMock(),writes=writeMock(mock);
  const blocked=async ()=>({status:'withheld',reason:'merge_requires_green_ci',
    evidence:{control_sha:controlSha,ci:'pending',latest_trusted_review_id:999}});
  const result=await merge(row,mock,writes,blocked);
  assert.equal(result.merged,false);
  assert.equal(result.decision.reason,'merge_requires_green_ci');
  assert.equal(writes.calls.some(c=>c.url.endsWith('/merge')),false);
});

test('a manually authored PR is reviewed by the worker App, never by its author',async()=>{
  const row=makeRow('APPROVE');
  const mock=apiMock({initialPr:pr({user:{login:'AlexBDevCorner'}})}),writes=writeMock(mock);
  await review(row,mock,writes);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.equal(sent.auth,'Bearer app');
  assert.equal(mock.reviews.at(-1).user.login,'autonomousworkdispatcher[bot]');
  assert.equal(writes.calls.some(c=>c.url.endsWith('/user')&&c.auth==='Bearer app'),false);
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

test('same reviewer handles a second enrolled repository without alternate code paths',async()=>{
  const row={...makeRow(),repository:'AlexBDevCorner/RepoManager',project_id:'repomanager',task_id:'RM-008'};
  const other=pr({
    head:{sha,ref:'autonomous/RM-008',repo:{full_name:'AlexBDevCorner/RepoManager'}},
    base:{ref:'master',repo:{full_name:'AlexBDevCorner/RepoManager'}},
  });
  const mock=apiMock({initialPr:other}),writes=writeMock(mock);
  assert.equal(await review(row,mock,writes),999);
  const sent=writes.calls.find(c=>c.url.endsWith('/pulls/4/reviews'));
  assert.ok(sent.url.includes('/repos/AlexBDevCorner/RepoManager/'));
  assert.equal(sent.body.commit_id,sha);
});
