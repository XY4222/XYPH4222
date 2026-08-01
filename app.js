const $ = (selector) => document.querySelector(selector);
const state = { items: [], filter: 'all' };
const demoItems = [
  { channel:'小红书', title:'通勤路上，把世界调成静音', content:'早高峰的地铁不该偷走你的专注。轻量降噪耳机把通勤变成一段只属于自己的时间：戴久不压耳，降噪刚刚好，一次充电陪你走完一周。\n\n今天的效率，从安静开始。', tags:['通勤好物','效率生活','降噪耳机'], score:96, news_title:'AI 可穿戴设备成为效率消费新趋势' },
  { channel:'抖音', title:'打工人的 30 分钟，终于还给自己', content:'地铁一进站，噪音消失；音乐一响，工作模式上线。不到一杯咖啡的重量，却有一整周的续航。你的移动专注舱，现在可以装进口袋。', tags:['职场效率','轻量佩戴'], score:93, news_title:'城市通勤时间与移动办公关注度上升' },
  { channel:'微博', title:'今日热议｜真正的效率，是少一点干扰', content:'信息越多，专注越稀缺。轻量降噪耳机不是隔绝世界，而是帮你重新选择听见什么。通勤、咖啡馆、临时会议，一副就够。', tags:['今日热议','数码新品'], score:90, news_title:'注意力管理成为年轻职场人讨论热点' },
  { channel:'小红书', title:'一周充一次电的耳机，治好了我的电量焦虑', content:'出门最怕耳机只剩 10%。这副轻量降噪耳机把续航做成了“无感体验”：周一装进包里，周末还有电。配合柔软耳帽，长途出行也不累耳。', tags:['续航实测','出行装备'], score:89, news_title:'暑期出行带动便携数码产品消费' },
  { channel:'抖音', title:'别卷时间了，先把噪音关掉', content:'同样 20 分钟，有人被噪音切碎，有人完成了一次深度思考。主动降噪、轻盈贴合、长效续航——把碎片时间拼回完整的自己。', tags:['自我提升','通勤神器'], score:88, news_title:'碎片化时间管理内容持续走红' },
  { channel:'微博', title:'耳机越来越轻，年轻人的边界感越来越清晰', content:'不想被打扰，不等于拒绝交流。一键切换降噪与通透模式，需要安静时专注，需要回应时在线。科技最好的样子，是懂得分寸。', tags:['边界感','科技生活'], score:86, news_title:'年轻消费者更加关注数字生活边界' }
];

function escapeHtml(value=''){ return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function normalizeItem(item, i){
  if(typeof item === 'string') return { channel:$('#channel').value, title:`营销灵感 ${i+1}`, content:item, tags:[], score:null, news_title:'Coze 工作流生成' };
  return { channel:item.channel||item.platform||$('#channel').value, title:item.title||item.headline||`营销灵感 ${i+1}`, content:item.content||item.copy||item.text||item.caption||'', tags:Array.isArray(item.tags)?item.tags:[], score:item.score||item.match_score||null, news_title:item.news_title||item.news||item.source||'Coze 工作流生成' };
}
function render(){
  const visible=state.items.filter(x=>state.filter==='all'||x.channel===state.filter);
  $('#resultCount').textContent=state.items.length;
  $('#emptyState').classList.toggle('hidden',state.items.length>0);
  $('#cardGrid').classList.toggle('hidden',state.items.length===0);
  $('#cardGrid').innerHTML=visible.map((item,i)=>`<article class="copy-card"><div class="card-top"><span class="source">${escapeHtml(item.channel)}</span>${item.score?`<span class="score">匹配度 ${escapeHtml(item.score)}%</span>`:''}</div><h3>${escapeHtml(item.title)}</h3><p class="content">${escapeHtml(item.content)}</p><div class="tags">${item.tags.map(t=>`<span># ${escapeHtml(t)}</span>`).join('')}</div><div class="card-foot"><span class="news-link" title="${escapeHtml(item.news_title)}">↗ ${escapeHtml(item.news_title)}</span><button class="copy-btn" data-copy="${i}">复制文案</button></div></article>`).join('');
  document.querySelectorAll('[data-copy]').forEach(btn=>btn.onclick=()=>copyText(visible[Number(btn.dataset.copy)]));
}
async function copyText(item){ await navigator.clipboard.writeText(`${item.title}\n\n${item.content}`); toast('文案已复制'); }
function toast(msg){ const el=$('#toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200); }
function setLoading(on){ $('#loadingState').classList.toggle('hidden',!on);$('#emptyState').classList.toggle('hidden',on||state.items.length>0);$('#cardGrid').classList.toggle('hidden',on||state.items.length===0);$('#runWorkflow').disabled=on;$('#runWorkflow').innerHTML=on?'生成中…':'<span>✦</span>开始生成'; }
async function checkStatus(){
  try{ const r=await fetch('/api/coze/status');const data=await r.json();const box=document.querySelector('.connection');box.classList.toggle('ready',data.configured);$('#connectionText').textContent=data.configured?'已连接':'待配置'; }catch{$('#connectionText').textContent='本地预览';}
}
async function run(){
  const payload={topic:$('#topic').value.trim(),product:$('#product').value.trim(),channel:$('#channel').value,count:Number($('#count').value)};
  if(!payload.topic||!payload.product){toast('请填写新闻方向和商品信息');return;}
  setLoading(true);$('#loadingText').textContent='连接 Coze 工作流…';
  try{
    const r=await fetch('/api/coze/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const data=await r.json();
    if(!r.ok) throw new Error(data.error||'工作流运行失败');
    if(!Array.isArray(data.items)||!data.items.length) throw new Error('工作流未返回文案数组');
    state.items=data.items.map(normalizeItem);state.filter='all';document.querySelectorAll('#filters button').forEach(x=>x.classList.toggle('active',x.dataset.filter==='all'));
    $('#resultMeta').textContent=`${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · Coze 工作流完成 · ${state.items.length} 条内容`;
    toast(`已生成 ${state.items.length} 条文案`);
  }catch(e){toast(e.message);if(/配置|TOKEN|WORKFLOW/i.test(e.message)) $('#settingsDialog').showModal();}
  finally{setLoading(false);render();}
}
$('#runWorkflow').onclick=run;
$('#loadDemo').onclick=()=>{state.items=demoItems.map(normalizeItem);$('#resultMeta').textContent='示例数据 · 6 条内容';render();toast('已加载示例文案');};
$('#openSettings').onclick=()=>$('#settingsDialog').showModal();
$('#filters').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.filter=b.dataset.filter;document.querySelectorAll('#filters button').forEach(x=>x.classList.toggle('active',x===b));render();};
$('#today').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
checkStatus();render();
