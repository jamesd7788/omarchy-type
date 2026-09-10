/* At a fixed font size, narrow windows rewrap. Verify the caret tracks
   correctly onto wrapped lines and after a mid-test resize. */
const http=require('http'),fs=require('fs'),WebSocket=require('ws');
const S='/tmp/claude-1000/-home-daniel/c04172d8-bfcb-4358-af1f-9390080eefeb/scratchpad';
const get=p=>new Promise((r,j)=>http.get({host:'127.0.0.1',port:9222,path:p},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>r(JSON.parse(d)))}).on('error',j));
(async()=>{
  const t=(await get('/json/list')).find(x=>x.type==='page'&&x.url.includes('8421'));
  const ws=new WebSocket(t.webSocketDebuggerUrl,{perMessageDeflate:false});
  let id=0;const p=new Map();
  const send=(m,q={})=>new Promise((res,rej)=>{const i=++id;p.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:q}));setTimeout(()=>{if(p.has(i)){p.delete(i);rej(new Error('to '+m))}},25000)});
  ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&p.has(o.id)){const{res,rej}=p.get(o.id);p.delete(o.id);o.error?rej(new Error(JSON.stringify(o.error))):res(o.result)}});
  await new Promise(r=>ws.on('open',r));
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const key=async c=>{const code=c===' '?'Space':'Key'+c.toUpperCase(),kc=c===' '?32:c.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent',{type:'keyDown',text:c,key:c,code,windowsVirtualKeyCode:kc,nativeVirtualKeyCode:kc});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:c,code,windowsVirtualKeyCode:kc,nativeVirtualKeyCode:kc});};
  const out=[];const ok=(n,c,d='')=>out.push(`${c?'PASS':'FAIL'}  ${n}${d?'  -- '+d:''}`);

  // Caret must sit on the active word wherever it wraps to.
  const caretOnWord = () => ev(`(()=>{
    const w=document.querySelectorAll('.word')[wi];
    const wr=w.getBoundingClientRect();
    const c=document.getElementById('caret').getBoundingClientRect();
    const wrap=document.getElementById('wrap').getBoundingClientRect();
    const got=(typed[wi]||'').length;
    const spans=w.children;
    let want;
    if(got===0) want=spans[0].getBoundingClientRect().left;
    else want=spans[Math.min(got,spans.length)-1].getBoundingClientRect().right;
    return JSON.stringify({
      dx:(c.left+c.width/2)-want,
      sameLine:Math.abs((c.top+c.height/2)-(wr.top+wr.height/2))<28,
      inView:c.top>=wrap.top-6&&c.bottom<=wrap.bottom+6,
      wordInView:wr.top>=wrap.top-6&&wr.bottom<=wrap.bottom+6,
    });
  })()`);

  for (const w of [1400, 700, 520, 420]) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:820,deviceScaleFactor:1,mobile:false});
    await new Promise(r=>setTimeout(r,400));
    await ev(`setZen(false); caret='bar'; paintModes(); setMaster(false); setMode('time',60); again();`);
    await new Promise(r=>setTimeout(r,350));

    // Type far enough to wrap onto lines 2 and 3.
    let bad=0, checks=0, worst=0;
    for (let n=0;n<26;n++){
      const word = await ev(`words[wi]`);
      for (const ch of word){ await key(ch); await new Promise(r=>setTimeout(r,8)); }
      await new Promise(r=>setTimeout(r,180));   // let the caret glide settle
      const g = JSON.parse(await caretOnWord());
      checks++;
      worst=Math.max(worst,Math.abs(g.dx));
      if (Math.abs(g.dx)>2 || !g.sameLine || !g.inView || !g.wordInView) bad++;
      await key(' '); await new Promise(r=>setTimeout(r,8));
    }
    const lines = await ev(`(()=>{
      const wrap=document.getElementById('wrap').getBoundingClientRect();
      const tops=[...new Set([...document.querySelectorAll('.word')].map(w=>Math.round(w.getBoundingClientRect().top)))].sort((a,b)=>a-b);
      return tops.filter(y=>y>=wrap.top-2&&y<wrap.bottom-4).length;
    })()`);
    ok(`@${w}px caret tracks the word across wrapped lines`, bad===0,
       `${checks-bad}/${checks} ok, worst dx ${worst.toFixed(2)}px, ${lines} lines`);
  }

  // Resize mid-test: caret must follow the rewrap, not strand itself.
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:820,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,350));
  await ev(`setMode('time',60); again();`);
  await new Promise(r=>setTimeout(r,300));
  for (let n=0;n<14;n++){
    const word = await ev(`words[wi]`);
    for (const ch of word){ await key(ch); await new Promise(r=>setTimeout(r,8)); }
    await key(' '); await new Promise(r=>setTimeout(r,8));
  }
  await ev(`words[wi]`);
  for (const ch of 'ab'){ await key(ch); await new Promise(r=>setTimeout(r,20)); }
  await new Promise(r=>setTimeout(r,250));
  const before = JSON.parse(await caretOnWord());
  await send('Emulation.setDeviceMetricsOverride',{width:520,height:820,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,700));
  const after = JSON.parse(await caretOnWord());
  ok('caret follows a mid-test resize',
     Math.abs(after.dx)<2 && after.sameLine && after.inView && after.wordInView,
     `dx ${before.dx.toFixed(2)} -> ${after.dx.toFixed(2)}, inView=${after.inView}, wordInView=${after.wordInView}`);

  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${S}/${n}.png`,Buffer.from(r.data,'base64'));console.log(n+'.png')};
  await shot('wrap-520');
  await send('Emulation.clearDeviceMetricsOverride');

  console.log(out.join('\n'));
  console.log(`\n${out.filter(l=>l.startsWith('PASS')).length}/${out.length} passed`);
  ws.close();process.exit(out.some(l=>l.startsWith('FAIL'))?1:0);
})().catch(e=>{console.log('ERROR '+e.message);process.exit(1)});
