// Upcoming matches and the live forecast check. Shared by the local app and the static
// snapshot; pure rendering from data that was logged before each match started.
import { kellyPlan,FLAG_EV } from './odds-market.js';

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=(x,d=1)=>x==null||!Number.isFinite(x)?'—':(x*100).toFixed(d)+'%';
const dec=(x,d=4)=>x==null||!Number.isFinite(x)?'—':Number(x).toFixed(d);
const fmt=x=>new Intl.NumberFormat('ru-RU').format(x??0);
const when=s=>new Date(s).toLocaleString('ru-RU',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const stars=n=>n>0?'★'.repeat(Math.min(5,n)):'';

function liveBlock(live){
  if(!live||!live.scored)return `<div class="r-warn"><strong>Живая проверка ещё не началась.</strong> Прогнозы записываются до начала каждого матча и засчитываются, когда матч сыгран. ${live?.forecasts?`Уже записано прогнозов: ${fmt(live.forecasts)}.`:''} Первые результаты появятся после следующего обновления данных.</div>`;
  const m=live.model,e=live.experienced,v=live.vsMarket;
  return `<div class="r-cards">
    <div class="r-card"><span>Засчитано прогнозов</span><b>${fmt(live.scored)}</b><small>с ${new Date(live.since).toLocaleDateString('ru-RU')}; медиана — за ${dec(live.medianLeadHours,1)} ч до начала</small></div>
    <div class="r-card"><span>Точность</span><b class="${m.accuracy>.5?'good':'bad'}">${pct(m.accuracy)}</b><small>монетка — 50%</small></div>
    <div class="r-card"><span>Log loss</span><b class="${m.logLoss<Math.log(2)?'good':'bad'}">${dec(m.logLoss)}</b><small>монетка — 0.6931, меньше лучше</small></div>
    <div class="r-card"><span>Без холодного старта</span><b>${pct(e?.accuracy)}</b><small>${fmt(e?.count)} матчей, где обе команды сыграли ≥5</small></div>
  </div>
  ${v?`<p class="r-note">На ${fmt(v.count)} матчах была предматчевая линия: Brier модели ${dec(v.model.brier)} против ${dec(v.market.brier)} у рынка (маржа снята методом Шина). ${v.count<200?'Этого пока мало для вывода.':''}</p>`:''}
  <p class="r-note">Каждый прогноз записывается с меткой времени до начала матча и больше не меняется; засчитывается последний, сделанный до старта. История публикаций этой страницы в git подтверждает, что прогнозы были сделаны заранее.</p>
  <details class="r-limits"><summary>Последние засчитанные прогнозы</summary><div class="r-scroll"><table class="r-table"><thead><tr><th>Матч</th><th class="r-num">P(A)</th><th>Итог</th></tr></thead><tbody>
    ${live.recent.map(r=>{const hit=(r.p>.5)===(r.y===1);return `<tr><td>${esc(r.teamA)} — ${esc(r.teamB)}<div class="r-muted" style="font-size:11px">${when(r.start)}</div></td><td class="r-num">${pct(r.p)}</td><td class="${r.p===.5?'':hit?'good':'bad'}">${r.y?esc(r.teamA):esc(r.teamB)} ${r.p===.5?'':hit?'✓':'✗'}</td></tr>`;}).join('')}
  </tbody></table></div></details>`;
}

function stakeCell(x){
  if(!x||x.status==='no-line')return '<span class="r-muted">—</span>';
  if(x.status==='no-edge')return '<span class="r-muted">не ставить</span><div class="r-muted" style="font-size:11px">EV ≤ 0</div>';
  if(x.status==='flagged')return `<span class="r-thin">⚠ пропуск</span><div class="r-muted" style="font-size:11px">полный Келли ${pct(x.full)}</div>`;
  if(x.status==='tiny')return '<span class="r-muted">&lt; 1 ₽</span>';
  return `<b>${fmt(x.stake)} ₽</b><div class="r-muted" style="font-size:11px">${pct(x.fraction,1)} банка · полный ${pct(x.full,1)}</div>`;
}

function rowHtml(f,x){
  const fav=f.p>=.5?'A':'B',pf=Math.max(f.p,1-f.p),line=f.line;
  const ev=f.bestSide;
  return `<tr>
    <td class="r-muted">${when(f.startsAt)}</td>
    <td><b style="color:${fav==='A'?'var(--text)':'var(--muted)'}">${esc(f.teamA)}</b> — <b style="color:${fav==='B'?'var(--text)':'var(--muted)'}">${esc(f.teamB)}</b>
      <div class="r-muted" style="font-size:11px">${esc(f.event)}${f.bestOf?` · BO${f.bestOf}`:''} ${stars(f.stars)}${f.coldStart?' · <span class="r-thin">мало матчей</span>':''}</div></td>
    <td class="r-num"><b>${pct(f.p)}</b><div class="r-muted" style="font-size:11px">${esc(fav==='A'?f.teamA:f.teamB)} ${pct(pf,0)}</div></td>
    <td class="r-num">${line?`${dec(line.oddsA,2)} / ${dec(line.oddsB,2)}<div class="r-muted" style="font-size:11px">рынок ${pct(f.marketA)}</div>`:'<span class="r-muted">нет линии</span>'}</td>
    <td class="r-num">${ev?`<span class="${ev.ev>FLAG_EV?'r-thin':ev.ev>0?'good':'bad'}" ${ev.ev>FLAG_EV?'title="Слишком большое расхождение с рынком: скорее модель чего-то не знает"':''}>${ev.ev>FLAG_EV?'⚠ ':''}${ev.ev>0?'+':''}${pct(ev.ev)}</span><div class="r-muted" style="font-size:11px">на ${esc(ev.side==='A'?f.teamA:f.teamB)} @ ${dec(ev.odds,2)}</div>`:'—'}</td>
    <td class="r-num">${stakeCell(x)}</td>
  </tr>`;
}

const SETTINGS='cs2-kelly-settings';
function loadSettings(){try{return {...JSON.parse(localStorage.getItem(SETTINGS)||'{}')};}catch{return {};}}
function saveSettings(v){try{localStorage.setItem(SETTINGS,JSON.stringify(v));}catch{}}

export function renderUpcoming(container,{upcoming=[],live=null,generated=null}={}){
  const state={withLine:false,starred:false,bank:2000,k:.25,cap:.05,totalCap:.3,skipFlagged:true,...loadSettings()};
  container.innerHTML=`<div class="r-root">
    <div class="r-panel"><div class="r-head"><h3>Ближайшие матчи</h3><span class="r-tag">${fmt(upcoming.length)} В СНИМКЕ</span></div><div class="r-body">
      <p class="r-note" style="margin-top:0">Прогноз командной модели, переобученной на всей истории к моменту обновления${generated?` (${when(generated)})`:''}. Линия — предматчевый коэффициент партнёрского букмекера bo3.gg на тот же момент, рынок — его вероятность без маржи. EV — ожидание на лучшую по модели сторону до комиссий.</p>
      <div class="r-picker market-inputs kelly-inputs">
        <label>Банк, ₽<input id="k-bank" type="number" min="1" step="100" value="${state.bank}"></label>
        <label>Доля Келли<select id="k-k"><option value="0.25">¼ — осторожно</option><option value="0.5">½</option><option value="1">полный</option></select></label>
        <label>Макс. на одну ставку, %<input id="k-cap" type="number" min="0.1" max="100" step="0.5" value="${state.cap*100}"></label>
        <label>Макс. на все ставки сразу, %<input id="k-total" type="number" min="1" max="100" step="1" value="${state.totalCap*100}"></label>
      </div>
      <div id="k-summary" class="r-note"></div>
      <label class="r-muted" style="font-size:12px;margin-right:16px"><input type="checkbox" id="k-skip" ${state.skipFlagged?'checked':''}> не ставить на ⚠</label>
      <label class="r-muted" style="font-size:12px;margin-right:16px"><input type="checkbox" id="up-line"> только с линией</label>
      <label class="r-muted" style="font-size:12px"><input type="checkbox" id="up-star"> только турниры со звёздами</label>
      <div class="r-scroll" style="margin-top:10px"><table class="r-table"><thead><tr><th>Начало</th><th>Матч</th><th class="r-num">Модель, P(A)</th><th class="r-num">Линия A / B</th><th class="r-num">EV</th><th class="r-num">Ставка по Келли</th></tr></thead><tbody id="up-rows"></tbody></table></div>
      <p class="r-note">Положительный EV здесь — расхождение модели с одной конторой, а не рекомендация ставки. Модель систематически осторожнее рынка: она не знает составов, замен и свежих новостей, поэтому большое расхождение (⚠, EV выше 15%) почти всегда означает её незнание, а не ошибку рынка — это «проклятие победителя». Ответ даст живая проверка ниже: сравнение с той же линией на сотнях сыгранных матчей. Матчи без линии и с «мало матчей» особенно ненадёжны.</p>
      <details class="r-limits"><summary>Как считается ставка по Келли</summary>
        <p>Ставка выгодна, только если вероятность модели q больше 1/p, где p — коэффициент. Доля банка, при которой капитал растёт быстрее всего на длинной дистанции: <b>f* = (q·p − 1) / (p − 1)</b>, ставка s* = f* × банк. Банк берётся текущий, поэтому после каждой ставки сумма пересчитывается.</p>
        <p>Формула верна при трёх допущениях: q — точная, откалиброванная вероятность; исходы независимы; ставки идут по одной. Первое для этой модели не доказано: если q завышена, полный Келли быстро разоряет. Поэтому по умолчанию стоит ¼ Келли, а ставки на ⚠, где модель расходится с рынком сильнее всего, пропускаются.</p>
        <p>Третье допущение здесь нарушено: матчи идут одновременно, а Келли для одной ставки не учитывает, что под риском сразу несколько. Поэтому стоят два лимита — на одну ставку и на все ставки сразу. Если сумма превышает общий лимит, все ставки уменьшаются в одинаковое число раз.</p>
      </details>
    </div></div>
    <div class="r-panel"><div class="r-head"><h3>Живая проверка прогнозов</h3><span class="r-tag good">БЕЗ УТЕЧЕК ПО ПОСТРОЕНИЮ</span></div><div class="r-body">${liveBlock(live)}</div></div>
  </div>`;
  const body=container.querySelector('#up-rows'),summary=container.querySelector('#k-summary');
  const $=id=>container.querySelector(id);
  $('#k-k').value=String(state.k);
  const draw=()=>{
    const now=Date.now();
    const rows=upcoming.filter(f=>Date.parse(f.startsAt)>now&&(!state.withLine||f.line)&&(!state.starred||f.stars>0));
    let plan;
    try{plan=kellyPlan(rows,state);summary.classList.remove('bad');}
    catch(e){summary.textContent=e.message;summary.classList.add('bad');plan=null;}
    // The plan covers exactly the matches on screen, since stakes on them run at the same time.
    const byId=new Map((plan?.items||[]).map(x=>[x.f.matchId,x]));
    body.innerHTML=rows.length?rows.map(f=>rowHtml(f,byId.get(f.matchId))).join(''):`<tr><td colspan="6" class="r-muted">${upcoming.length?'Под фильтр ничего не попало или все матчи из снимка уже начались — обновите данные.':'Список пуст: запустите npm run update.'}</td></tr>`;
    // Kelly is only as good as q. When the live check says the line beats the model on the same
    // matches, the sizes below are an exercise, and the page says so above the numbers.
    const v=live?.vsMarket,behind=v&&v.market.brier<v.model.brier;
    const caution=behind?`<span class="r-thin">Живая проверка: на ${fmt(v.count)} сыгранных матчах с линией рынок точнее модели (Brier ${dec(v.market.brier)} против ${dec(v.model.brier)}). Пока это так, у этих ставок ожидание отрицательное, и суммы ниже — расчёт по формуле, а не рекомендация.</span><br>`:'';
    if(plan)summary.innerHTML=caution+(plan.bets
      ?`По Келли: <b>${fmt(plan.bets)}</b> ${plan.bets===1?'ставка':'ставок'} на <b>${fmt(plan.total)} ₽</b> — ${pct(plan.exposure)} банка одновременно.${plan.scale<1?` Суммарно Келли просил ${pct(plan.wanted)} банка, поэтому все ставки уменьшены в ${dec(1/plan.scale,1)} раза до общего лимита.`:''}`
      :'По Келли ставок нет: ни у одного матча на экране нет положительного EV в допустимых пределах.');
  };
  const setNumber=(key,scale)=>e=>{const v=Number(e.target.value)/scale;if(Number.isFinite(v)&&v>0){state[key]=v;saveSettings(pick(state));draw();}};
  const pick=s=>({bank:s.bank,k:s.k,cap:s.cap,totalCap:s.totalCap,skipFlagged:s.skipFlagged});
  $('#k-bank').oninput=setNumber('bank',1);
  $('#k-cap').oninput=setNumber('cap',100);
  $('#k-total').oninput=setNumber('totalCap',100);
  $('#k-k').onchange=e=>{state.k=Number(e.target.value);saveSettings(pick(state));draw();};
  $('#k-skip').onchange=e=>{state.skipFlagged=e.target.checked;saveSettings(pick(state));draw();};
  $('#up-line').onchange=e=>{state.withLine=e.target.checked;draw();};
  $('#up-star').onchange=e=>{state.starred=e.target.checked;draw();};
  draw();
}

export function mountUpcomingUI({$,api,head,state}){
  return {async upcomingView(epoch){
    const d=await api('upcoming');if(epoch!==state.epoch)return;
    $('#main').innerHTML=head('Ближайшие матчи','Прогнозы, записанные до начала матчей, и их проверка.')+'<div id="upcoming-root"></div>';
    renderUpcoming($('#upcoming-root'),d);
  }};
}
