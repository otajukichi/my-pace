import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {CsvBytes} from './import-core.mjs';
test('over 100 MB bounded streaming, UTF8/quoted newline, crash-state resumes and independent digest',()=>{
 const record='"日本語\nquoted ""value""",1234567890123456789012345678901234567890\r\n';
 const line=Buffer.from(record), expected=['日本語\nquoted "value"','1234567890123456789012345678901234567890'];
 const recordCount=1600000, blockRows=1000, block=Buffer.from(record.repeat(blockRows));
 assert.ok(recordCount*line.length>100*1024*1024);
 const reference=createHash('sha256'),actual=createHash('sha256');
 const canonical=JSON.stringify(expected)+'\n';for(let i=0;i<recordCount;i++)reference.update(canonical);
 const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
 let p=new CsvBytes({decode}),rows=0,maxState=0,bytes=0,chunks=0;
 const emit=r=>{rows++;actual.update(JSON.stringify(r)+'\n');};
 for(let batch=0;batch<recordCount/blockRows;batch++){
  // Deliberately unaligned request-sized input; retained state includes partial UTF8/quotes.
  const split=(batch*97)%block.length;
  for(const part of [block.subarray(0,split),block.subarray(split)]){
   p.feed(part,emit);bytes+=part.length;chunks++;
   const state=p.snapshot();maxState=Math.max(maxState,JSON.stringify(state).length);
   // Model process death/reconstruction between every bounded request, no retained parser.
   p=new CsvBytes({decode,state});
  }
 }
 p.feed([],emit,true);assert.equal(rows,recordCount);assert.equal(actual.digest('hex'),reference.digest('hex'));assert.ok(maxState<4096);
 console.log(JSON.stringify({syntheticBytes:bytes,records:rows,chunks,maxCheckpointJSONBytes:maxState,requestMaxBytes:block.length}));
});
