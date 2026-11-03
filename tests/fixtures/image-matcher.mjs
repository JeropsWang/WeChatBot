import {createInterface} from 'node:readline';
process.stdout.write(JSON.stringify({type:'ready',referenceCount:8})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.path==='exit')process.exit(2);
 if(request.path==='slow')return;
 process.stdout.write(JSON.stringify({id:request.path==='wrong-id'?'another':request.id,result:{status:'ok',metric:'cosine_similarity',calibrated:false,similarity:request.path==='bad-score'?2:0.75,matchedReference:'reference-1',category:'合成表情',matches:[]}})+'\n');
});
