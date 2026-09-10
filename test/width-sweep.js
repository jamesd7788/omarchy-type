/* Check caret geometry across viewport widths. */
const http=require('http'),fs=require('fs'),WebSocket=require('ws');
const S='/tmp/claude-1000/-home-daniel/c04172d8-bfcb-4358-af1f-9390080eefeb/scratchpad';
const get=p=>new Promise((r,j)=>http.get({host:'127.0.0.1',port:9222,path:p},s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>r(JSON.parse(d)))}).on('error',j));
(async()=>{
  const t=(await get('/json/list')).find(x=>x.type==='page'&&x.url.includes('8421'));
  const ws=new WebSocket(t.webSocketDebuggerUrl,{perMessageDeflate:false});
  let id=0;const p=new Map();
  const send=(m,q={})=>new Promise((res,rej)=>{const i=++id;p.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:q}));setTimeout(()=>{if(p.has(i)){p.delete(i);rej(new Error('to '+m))}},20000)});
  ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&p.has(o.id)){const{res,rej}=p.get(o.id);p.delete(o.id);o.error?rej(new Error(JSON.stringify(o.error))):res(o.result)}});
  await new Promise(r=>ws.on('open',r));
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const key=async c=>{const code=c===' '?'Space':'Key'+c.toUpperCase(),kc=c===' '?32:c.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent',{type:'keyDown',text:c,key:c,code,windowsVirtualKeyCode:kc,nativeVirtualKeyCode:kc});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:c,code,windowsVirtualKeyCode:kc,nativeVirtualKeyCode:kc});};

  const widths=[1400,1100,900,760,680,560,480,400,360];
  const rows=[];
  for (const w of widths) {
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:820,deviceScaleFactor:1,mobile:false});
    await new Promise(r=>setTimeout(r,350));
    await ev(`setZen(false); caret='bar'; paintModes(); setMaster(false); setMode('time',30); again();`);
    await new Promise(r=>setTimeout(r,300));
    await ev(`words.splice(0,2,'apply','gypsy'); render(); moveCaret();`);
    await new Promise(r=>setTimeout(r,150));
    for (const ch of 'app') { await key(ch); await new Promise(r=>setTimeout(r,25)); }
    await new Promise(r=>setTimeout(r,350));

    const g = JSON.parse(await ev(`(()=>{
      const cs=getComputedStyle(document.documentElement);
      const c=document.getElementById('caret').getBoundingClientRect();
      const spans=[...document.querySelectorAll('.word')[0].children];
      const next=spans[3].getBoundingClientRect();
      const words=document.getElementById('words');
      const wrap=document.getElementById('wrap').getBoundingClientRect();
      const wcs=getComputedStyle(words);
      const line=parseFloat(wcs.lineHeight);
      // how many lines are visible in the wrap
      const tops=[...new Set([...document.querySelectorAll('.word')].map(w=>Math.round(w.getBoundingClientRect().top)))].sort((a,b)=>a-b);
      const visible=tops.filter(y=>y>=wrap.top-2&&y<wrap.bottom-4).length;
      return JSON.stringify({
        fontSize:wcs.fontSize, line,
        capTop:parseFloat(cs.getPropertyValue('--cap-top')),
        ink:parseFloat(cs.getPropertyValue('--ink')),
        charW:parseFloat(cs.getPropertyValue('--char-w')),
        caretH:c.height, caretW:c.width,
        cellW:next.width,
        dLeft:c.left-next.left,
        caretTopRel:c.top-next.top,
        caretBotRel:c.bottom-next.bottom,
        // caret position within the line box, vs the measured ink band
        inkTopGap:(c.top-wrap.top)%line===0?0:null,
        caretTopInLine:c.top-(next.top-(parseFloat(cs.getPropertyValue('--cap-top'))||0)),
        overTop:(parseFloat(cs.getPropertyValue('--cap-top'))||0)-(c.top-next.top),
        visible, wrapH:wrap.height,
      });
    })()`));
    rows.push({w,...g});
  }
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('width  font   line  ratio ink   caretH  cellW  charW  dLeft  rise/em lines');
  for (const r of rows) {
    const ratio=r.line/parseFloat(r.fontSize);
    console.log(
      String(r.w).padEnd(6),
      String(r.fontSize).padEnd(6),
      String(r.line).padEnd(5),
      ratio.toFixed(2).padEnd(5),
      r.ink.toFixed(1).padEnd(5),
      r.caretH.toFixed(1).padEnd(7),
      r.cellW.toFixed(2).padEnd(6),
      String(r.charW.toFixed(2)).padEnd(6),
      r.dLeft.toFixed(2).padEnd(6),
      (r.overTop/parseFloat(r.fontSize)).toFixed(3).padEnd(7),
      String(r.visible)
    );
  }
  console.log('\nproblems:');
  let bad=0;
  for (const r of rows) {
    const issues=[];
    if (Math.abs(r.charW-r.cellW)>0.6) issues.push(`char-w ${r.charW.toFixed(2)} != cell ${r.cellW.toFixed(2)}`);
    if (Math.abs(r.dLeft+r.caretW/2)>0.8) issues.push(`bar offset ${r.dLeft.toFixed(2)} (want ${(-r.caretW/2).toFixed(2)})`);
    if (r.visible!==3) issues.push(`${r.visible} lines visible`);
    const ratio=r.line/parseFloat(r.fontSize);
    if (Math.abs(ratio-1.5)>0.02) issues.push(`line/font ratio ${ratio.toFixed(2)} (want 1.50)`);
    // The bar's overshoot above the ink top should scale with the type,
    // staying a roughly constant fraction of the font size.
    const frac=r.overTop/parseFloat(r.fontSize);
    if (frac<0.15||frac>0.45) issues.push(`bar rise ${frac.toFixed(3)}em of font (want ~0.2-0.4)`);
    if (issues.length){bad++;console.log(`  ${r.w}px: ${issues.join('; ')}`);}
  }
  if(!bad) console.log('  none');
  ws.close();process.exit(0);
})().catch(e=>{console.log('ERR '+e.message);process.exit(1)});
