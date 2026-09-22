// Upcoming matches and the live forecast check. Shared by the local app and the static
// snapshot; pure rendering from data that was logged before each match started.
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

function rowHtml(f){
  const fav=f.p>=.5?'A':'B',pf=Math.max(f.p,1-f.p),line=f.line;
  const ev=f.bestSide;
  return `<tr>
    <td class="r-muted">${when(f.startsAt)}</td>
    <td><b style="color:${fav==='A'?'var(--text)':'var(--muted)'}">${esc(f.teamA)}</b> — <b style="color:${fav==='B'?'var(--text)':'var(--muted)'}">${esc(f.teamB)}</b>
      <div class="r-muted" style="font-size:11px">${esc(f.event)}${f.bestOf?` · BO${f.bestOf}`:''} ${stars(f.stars)}${f.coldStart?' · <span class="r-thin">мало матчей</span>':''}</div></td>
    <td class="r-num"><b>${pct(f.p)}</b><div class="r-muted" style="font-size:11px">${esc(fav==='A'?f.teamA:f.teamB)} ${pct(pf,0)}</div></td>
    <td class="r-num">${line?`${dec(line.oddsA,2)} / ${dec(line.oddsB,2)}<div class="r-muted" style="font-size:11px">рынок ${pct(f.marketA)}</div>`:'<span class="r-muted">нет линии</span>'}</td>
    <td class="r-num">${ev?`<span class="${ev.ev>.15?'r-thin':ev.ev>0?'good':'bad'}" ${ev.ev>.15?'title="Слишком большое расхождение с рынком: скорее модель чего-то не знает"':''}>${ev.ev>.15?'⚠ ':''}${ev.ev>0?'+':''}${pct(ev.ev)}</span><div class="r-muted" style="font-size:11px">на ${esc(ev.side==='A'?f.teamA:f.teamB)} @ ${dec(ev.odds,2)}</div>`:'—'}</td>
  </tr>`;
}

export function renderUpcoming(container,{upcoming=[],live=null,generated=null}={}){
  const state={withLine:false,starred:false};
  container.innerHTML=`<div class="r-root">
    <div class="r-panel"><div class="r-head"><h3>Ближайшие матчи</h3><span class="r-tag">${fmt(upcoming.length)} В СНИМКЕ</span></div><div class="r-body">
      <p class="r-note" style="margin-top:0">Прогноз командной модели, переобученной на всей истории к моменту обновления${generated?` (${when(generated)})`:''}. Линия — предматчевый коэффициент партнёрского букмекера bo3.gg на тот же момент, рынок — его вероятность без маржи. EV — ожидание на лучшую по модели сторону до комиссий.</p>
      <label class="r-muted" style="font-size:12px;margin-right:16px"><input type="checkbox" id="up-line"> только с линией</label>
      <label class="r-muted" style="font-size:12px"><input type="checkbox" id="up-star"> только турниры со звёздами</label>
      <div class="r-scroll" style="margin-top:10px"><table class="r-table"><thead><tr><th>Начало</th><th>Матч</th><th class="r-num">Модель, P(A)</th><th class="r-num">Линия A / B</th><th class="r-num">EV</th></tr></thead><tbody id="up-rows"></tbody></table></div>
      <p class="r-note">Положительный EV здесь — расхождение модели с одной конторой, а не рекомендация ставки. Модель систематически осторожнее рынка: она не знает составов, замен и свежих новостей, поэтому большое расхождение (⚠, EV выше 15%) почти всегда означает её незнание, а не ошибку рынка — это «проклятие победителя». Ответ даст живая проверка ниже: сравнение с той же линией на сотнях сыгранных матчей. Матчи без линии и с «мало матчей» особенно ненадёжны.</p>
    </div></div>
    <div class="r-panel"><div class="r-head"><h3>Живая проверка прогнозов</h3><span class="r-tag good">БЕЗ УТЕЧЕК ПО ПОСТРОЕНИЮ</span></div><div class="r-body">${liveBlock(live)}</div></div>
  </div>`;
  const body=container.querySelector('#up-rows');
  const draw=()=>{
    const now=Date.now();
    const rows=upcoming.filter(f=>Date.parse(f.startsAt)>now&&(!state.withLine||f.line)&&(!state.starred||f.stars>0));
    body.innerHTML=rows.length?rows.map(rowHtml).join(''):`<tr><td colspan="5" class="r-muted">${upcoming.length?'Под фильтр ничего не попало или все матчи из снимка уже начались — обновите данные.':'Список пуст: запустите npm run update.'}</td></tr>`;
  };
  container.querySelector('#up-line').onchange=e=>{state.withLine=e.target.checked;draw();};
  container.querySelector('#up-star').onchange=e=>{state.starred=e.target.checked;draw();};
  draw();
}

export function mountUpcomingUI({$,api,head,state}){
  return {async upcomingView(epoch){
    const d=await api('upcoming');if(epoch!==state.epoch)return;
    $('#main').innerHTML=head('Ближайшие матчи','Прогнозы, записанные до начала матчей, и их проверка.')+'<div id="upcoming-root"></div>';
    renderUpcoming($('#upcoming-root'),d);
  }};
}
