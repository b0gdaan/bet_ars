// RAPM view shared by the local app and the static snapshot. Pure rendering:
// it receives the already built model and never fetches anything itself.
import { predictLineups, lineupChange } from './lineups.js';

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>new Intl.NumberFormat('ru-RU').format(n??0);
const dec=(n,d=4)=>n===null||n===undefined||!Number.isFinite(n)?'—':Number(n).toFixed(d);
const pct=n=>n===null||n===undefined||!Number.isFinite(n)?'—':(n*100).toFixed(1)+'%';
const signed=(n,d=4)=>n===null||n===undefined||!Number.isFinite(n)?'—':(n>=0?'+':'')+n.toFixed(d);
const date=s=>s?new Date(s).toLocaleDateString('ru-RU',{day:'2-digit',month:'short',year:'numeric'}):'—';

const MODES={series:'Серии',round:'Раунды Mirage'};

// A positive delta means the player model is worse than the reference it is judged against.
function verdict(evaluation) {
  const d=evaluation.deltaBrier,ci=evaluation.deltaBrier95;
  if(!ci)return {tone:'warn',text:'Для интервала неопределённости нужно минимум 20 матчей в тесте.'};
  if(ci.upper<0)return {tone:'good',text:'Модель по игрокам точнее базовой: весь интервал разницы Brier лежит ниже нуля.'};
  if(ci.lower>0)return {tone:'bad',text:'Модель по игрокам хуже базовой: весь интервал разницы Brier лежит выше нуля.'};
  return {tone:'warn',text:`Различие не отличимо от нуля: интервал разницы Brier ${signed(ci.lower)} … ${signed(ci.upper)} накрывает ноль. Точечная оценка ${d>0?'в пользу базовой модели':'в пользу модели по игрокам'}.`};
}

function metricsTable(fit) {
  const e=fit.evaluation,rows=[['Модель по игрокам (RAPM)',e.test,true],[e.reference.name,e.reference,false]];
  return `<div class="r-scroll"><table class="r-table"><thead><tr><th>Модель</th><th class="r-num">Log loss ↓</th><th class="r-num">Brier ↓</th><th class="r-num">Accuracy ↑</th><th class="r-num">ROC-AUC ↑</th></tr></thead><tbody>
    ${rows.map(([label,m,main])=>`<tr class="${main?'r-main':''}"><td>${esc(label)}</td><td class="r-num">${dec(m?.logLoss)}</td><td class="r-num">${dec(m?.brier)}</td><td class="r-num">${pct(m?.accuracy)}</td><td class="r-num">${dec(m?.auc,3)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function calibration(bins) {
  if(!bins?.length)return '<p class="r-note">Нет данных для калибровки.</p>';
  return `<svg class="r-cal" viewBox="0 0 380 290" role="img" aria-label="Калибровка модели по игрокам">
    <path d="M45 15V245H360" fill="none" stroke="#414c5a"/>
    ${[0,.25,.5,.75,1].map(v=>`<line x1="45" y1="${245-v*225}" x2="360" y2="${245-v*225}" stroke="#2b3542"/><text x="14" y="${249-v*225}">${v*100}</text><text x="${36+v*310}" y="265">${v*100}</text>`).join('')}
    <line x1="45" y1="245" x2="355" y2="20" stroke="#667585" stroke-dasharray="5 5"/>
    ${bins.map(b=>`<circle cx="${45+b.predicted*310}" cy="${245-b.actual*225}" r="${Math.min(13,4+Math.sqrt(b.count)/2)}" fill="#efa268" fill-opacity=".85"><title>${b.count} наблюдений: прогноз ${pct(b.predicted)}, факт ${pct(b.actual)}</title></circle>`).join('')}
    <text x="100" y="286">Предсказанная вероятность, %</text></svg>`;
}

function notTrained(fit) {
  const s=fit.skipped||{};
  return `<div class="r-panel"><div class="r-head"><h3>${MODES[fit.mode]||fit.mode}</h3><span class="r-tag warn">НЕ ОБУЧЕНА</span></div>
    <div class="r-body"><p>${esc(fit.note||'Недостаточно данных.')}</p>
    <table class="r-table r-compact"><tbody>
      <tr><td>Наблюдений</td><td class="r-num">${fmt(fit.observations)}</td></tr>
      <tr><td>Матчей с полными составами</td><td class="r-num">${fmt(fit.matches)}</td></tr>
      <tr><td>Пропущено: результат ещё не доступен</td><td class="r-num">${fmt(s.unavailable)}</td></tr>
      <tr><td>Пропущено: состав не 5 на 5</td><td class="r-num">${fmt(s.lineup)}</td></tr>
      <tr><td>Пропущено: нет контекста раунда</td><td class="r-num">${fmt(s.context)}</td></tr>
    </tbody></table></div></div>`;
}

function fitBlock(fit,id) {
  if(fit.status!=='trained')return notTrained(fit);
  const e=fit.evaluation,v=verdict(e);
  const confounded=fit.players.filter(p=>p.inseparable>1);
  const thin=fit.players.filter(p=>p.matches<10).length;
  return `<div class="r-panel"><div class="r-head"><h3>${MODES[fit.mode]||fit.mode}</h3><span class="r-tag">λ = ${fit.lambda}</span><span class="r-tag ${v.tone}">${v.tone==='good'?'ЛУЧШЕ БАЗЫ':v.tone==='bad'?'ХУЖЕ БАЗЫ':'БЕЗ РАЗЛИЧИЯ'}</span></div>
    <div class="r-body">
      <div class="r-cards">
        <div class="r-card"><span>Наблюдений</span><b>${fmt(fit.observations)}</b><small>${fmt(fit.matches)} матчей, единица — ${esc(fit.unit)}</small></div>
        <div class="r-card"><span>Тест</span><b>${fmt(e.test.count)}</b><small>с ${date(e.testFrom)}, обучение ${fmt(e.fit)}</small></div>
        <div class="r-card"><span>Δ Brier к базе</span><b class="${e.deltaBrier>0?'bad':'good'}">${signed(e.deltaBrier)}</b><small>${e.deltaBrier95?`95%: ${signed(e.deltaBrier95.lower)} … ${signed(e.deltaBrier95.upper)}`:'интервал недоступен'}</small></div>
        <div class="r-card"><span>Холодный старт</span><b>${fmt(e.coldStartRows)}</b><small>наблюдений с игроком без коэффициента</small></div>
      </div>
      <p class="r-verdict ${v.tone}">${esc(v.text)}</p>
      ${metricsTable(fit)}
      <p class="r-note">Меньше — лучше для log loss и Brier. Положительная Δ Brier означает, что модель по игрокам проигрывает базовой на тех же наблюдениях. Accuracy считается при пороге 0,5 и не проверяет калибровку.</p>
      <div class="r-split">
        <div>
          <h4>Подбор регуляризации на валидации</h4>
          <div class="r-scroll"><table class="r-table"><thead><tr><th class="r-num">λ</th><th class="r-num">Log loss</th><th class="r-num">Brier</th><th class="r-num">Accuracy</th><th>Сходимость</th></tr></thead><tbody>
            ${e.candidates.map(c=>`<tr class="${c.lambda===fit.lambda?'r-main':''}"><td class="r-num">${c.lambda}</td><td class="r-num">${dec(c.logLoss)}</td><td class="r-num">${dec(c.brier)}</td><td class="r-num">${pct(c.accuracy)}</td><td>${c.converged?'да':'нет'}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="r-note">Валидация — матчи с ${date(e.validationFrom)} до ${date(e.testFrom)} (${fmt(e.validation)} наблюдений). Исключено из-за позднего окончания: ${fmt(e.purged)}. Оптимизатор: ${fit.optimizer.converged?'сошёлся':'не сошёлся'} за ${fmt(fit.optimizer.passes)} проходов, шаг ${dec(fit.optimizer.maxStep,8)}.</p>
        </div>
        <div><h4>Калибровка на тесте</h4>${calibration(e.calibration)}</div>
      </div>
      ${e.afterChanges?.rapm?`<p class="r-note">Только матчи сразу после смены состава: ${fmt(e.afterChanges.rapm.count)} наблюдений, Brier ${dec(e.afterChanges.rapm.brier)} против ${dec(e.afterChanges.reference?.brier)} у базовой модели. Это подвыборка, выбранная после факта, а не заранее зафиксированная гипотеза.</p>`:''}
      <div class="r-warn">
        <strong>Идентифицируемость.</strong> ${confounded.length?`${fmt(confounded.length)} игроков неотличимы друг от друга: они появляются ровно в одних и тех же наблюдениях с одним знаком, и L2 делит общий сигнал поровну. Их коэффициенты нельзя читать как индивидуальный вклад.`:'Полностью неразделимых игроков не найдено.'} Игроков с менее чем 10 матчами: ${fmt(thin)}.
      </div>
      <h4>Коэффициенты игроков</h4>
      <input class="r-search" id="${id}-q" placeholder="Поиск игрока…" aria-label="Поиск игрока">
      <div id="${id}-table"></div>
      <details class="r-limits"><summary>Ограничения модели (${fit.limitations.length})</summary><ul>${fit.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>
    </div></div>`;
}

function playerTable(fit,query) {
  const rows=fit.players.filter(p=>p.name.toLowerCase().includes(query.toLowerCase()));
  if(!rows.length)return '<p class="r-note">Никого не найдено.</p>';
  return `<div class="r-scroll"><table class="r-table"><thead><tr><th>#</th><th>Игрок</th><th class="r-num">β</th><th class="r-num">Эффект, п.п.</th><th class="r-num">Матчи</th><th class="r-num">Партнёры</th><th class="r-num">Соперники</th><th>Разделимость</th></tr></thead><tbody>
    ${rows.slice(0,200).map((p,i)=>`<tr><td class="r-muted">${fit.players.indexOf(p)+1}</td><td>${esc(p.name)}</td><td class="r-num ${p.coefficient>0?'good':'bad'}">${signed(p.coefficient,3)}</td><td class="r-num">${signed(p.neutralEffect,1)}</td><td class="r-num ${p.matches<10?'r-thin':''}">${p.matches}</td><td class="r-num">${p.teammates}</td><td class="r-num">${p.opponents}</td><td>${p.inseparable>1?`<span class="r-tag bad">неотличим от ${p.inseparable-1}</span>`:'<span class="r-muted">отделим</span>'}</td></tr>`).join('')}
  </tbody></table></div><p class="r-note">${rows.length>200?`Показаны первые 200 из ${fmt(rows.length)}.`:`${fmt(rows.length)} игроков.`} β — коэффициент в логите исхода; «эффект» переводит его в проценты для нейтрального матча и не является приростом от замены игрока. Коэффициенты обучены на всей доступной истории после отдельной проверки на тесте.</p>`;
}

function predictorBlock(rapm,fit) {
  const known=new Set(fit.players.map(p=>p.id));
  const rosters=rapm.rosters.filter(t=>t.players?.length===5&&t.players.every(id=>known.has(id)));
  if(rosters.length<2)return `<div class="r-panel"><div class="r-head"><h3>Прогноз по составам</h3></div><div class="r-body"><p class="r-note">Нужны хотя бы две команды, у всех пяти игроков которых есть обученный коэффициент. Сейчас таких ${fmt(rosters.length)}.</p></div></div>`;
  const options=rosters.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  return `<div class="r-panel"><div class="r-head"><h3>Прогноз по составам</h3><span class="r-tag">${MODES[fit.mode]}</span></div>
    <div class="r-body">
      <div class="r-picker"><select id="rapm-a" aria-label="Состав A">${options}</select><span>VS</span><select id="rapm-b" aria-label="Состав B">${options}</select></div>
      <details><summary>Проверить замену игрока</summary><div class="r-picker">
        <select id="rapm-slot" aria-label="Кого заменить"></select><span>→</span>
        <select id="rapm-in" aria-label="Кто войдёт в состав"><option value="">Без замены</option>${[...fit.players].sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${p.matches} матчей</option>`).join('')}</select>
      </div><p class="r-note">Сценарий одной замены в любой команде. Показывается изменение прогноза относительно исходных пятёрок; это не причинная оценка трансфера.</p></details>
      <div id="rapm-out"></div>
      <p class="r-note">По умолчанию берётся последняя наблюдавшаяся пятёрка команды. Можно проверить сценарий замены выше. Для неизвестного игрока вероятность не считается. Это оценка по истории, а не подтверждённый состав анонсированного матча.</p>
    </div></div>`;
}

function rosterBlock(rapm) {
  const changes=rapm.changes.slice(0,25);
  return `<div class="r-panel"><div class="r-head"><h3>Смены составов</h3><span class="r-tag">${fmt(rapm.changeCount)} всего</span></div>
    <div class="r-scroll"><table class="r-table"><thead><tr><th>Дата</th><th>Команда</th><th>Пришли</th><th>Ушли</th><th class="r-num">Осталось</th></tr></thead><tbody>
      ${changes.map(c=>`<tr><td class="r-muted">${date(c.start)}</td><td>${esc(c.team)}</td><td class="good">${c.in.map(esc).join(', ')||'—'}</td><td class="bad">${c.out.map(esc).join(', ')||'—'}</td><td class="r-num">${c.retained}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="r-body"><p class="r-note">Состав фиксируется по записи матча, поэтому смена видна только задним числом, после первой игры нового состава. Показаны последние 25 из ${fmt(rapm.changeCount)}. Отслежено команд: ${fmt(rapm.rosters.length)}.</p></div></div>`;
}

export function renderRapm(container,rapm) {
  if(!rapm||!rapm.version){container.innerHTML='<p class="r-note">Снимок RAPM отсутствует.</p>';return;}
  const trained=[rapm.series,rapm.round].find(f=>f.status==='trained');
  container.innerHTML=`<div class="r-root">
    <div class="r-intro"><p>Регуляризованная модель вклада игроков: вероятность исхода собирается из подписанных коэффициентов десяти игроков, а не из рейтинга названия команды. Коэффициент условен относительно партнёров и соперников и не является причинным эффектом замены.</p>
      <p class="r-note">Снимок от ${date(rapm.asOf)} · источник ${esc(rapm.source)} · ${esc(rapm.version)}</p></div>
    ${fitBlock(rapm.series,'rapm-series')}
    ${fitBlock(rapm.round,'rapm-round')}
    ${trained?predictorBlock(rapm,trained):''}
    ${rosterBlock(rapm)}
    <div class="r-panel"><div class="r-head"><h3>Методика</h3></div><div class="r-body"><p class="r-note">${esc(rapm.methodology)}</p></div></div>
  </div>`;

  for(const [fit,id] of [[rapm.series,'rapm-series'],[rapm.round,'rapm-round']]) {
    if(fit.status!=='trained')continue;
    const table=container.querySelector(`#${id}-table`),search=container.querySelector(`#${id}-q`);
    const draw=()=>{table.innerHTML=playerTable(fit,search.value);};
    search.oninput=draw;draw();
  }

  if(!trained)return;
  const a=container.querySelector('#rapm-a'),b=container.querySelector('#rapm-b'),out=container.querySelector('#rapm-out');
  if(!a||!b)return;
  const byId=new Map(rapm.rosters.map(t=>[t.id,t]));
  const slot=container.querySelector('#rapm-slot'),incoming=container.querySelector('#rapm-in');
  const names=new Map(trained.players.map(p=>[p.id,p.name]));
  if(b.options.length>1)b.selectedIndex=1;
  const show=()=>{
    const baseA=byId.get(a.value),baseB=byId.get(b.value);
    const x=baseA&&{...baseA,players:[...baseA.players]},y=baseB&&{...baseB,players:[...baseB.players]};
    if(!x||!y)return;
    if(x.id===y.id){out.innerHTML='<p class="r-note">Выберите две разные команды.</p>';return;}
    try {
      const params={sideA:'CT',equipmentA:20000,equipmentB:20000};
      const before=predictLineups(trained,x.players,y.players,params).p;
      if(incoming.value){const [side,index]=slot.value.split(':');(side==='A'?x:y).players[Number(index)]=incoming.value;}
      const forward=predictLineups(trained,x.players,y.players,params);
      const back=predictLineups(trained,y.players,x.players,{...params,sideA:'T'});
      const roster=t=>t.players.map(id=>esc(names.get(id)||id)).join(', ');
      const diff=lineupChange(y.players,x.players);
      out.innerHTML=`<div class="r-prob"><b>${pct(forward.p)}</b><span>ВЕРОЯТНОСТЬ ПОБЕДЫ</span><b>${pct(1-forward.p)}</b></div>
        <div class="r-bar"><span style="width:${(forward.p*100).toFixed(1)}%"></span></div>
        <div class="r-side"><span>${roster(x)}</span><span>${roster(y)}</span></div>
        ${incoming.value?`<p class="r-note">До замены: ${pct(before)} для A. Изменение по модели: ${signed((forward.p-before)*100,2)} п.п. Это условная оценка через коэффициенты, а не причинный эффект замены: игрок, почти не игравший с новыми партнёрами, получает коэффициент из совсем другого контекста.</p>`:''}
        <p class="r-note">Логит ${dec(forward.logit,3)}. Обратная постановка даёт ${pct(back.p)}, сумма ${dec(forward.p+back.p,6)} — симметрия сторон точная. Общих игроков у составов: ${5-diff.in.length}.</p>
        ${forward.lowSample.length?`<p class="r-note r-thin">Игроков с менее чем 10 матчами: ${forward.lowSample.length} — коэффициент сильно стянут к нулю.</p>`:''}
        ${forward.confounded.length?`<p class="r-note r-thin">Игроков, неотличимых от партнёров: ${forward.confounded.length} — их личный вклад по этим данным не выделяется.</p>`:''}`;
    } catch(e) {
      out.innerHTML=`<p class="r-note bad">${esc(e.message)}</p>`;
    }
  };
  const reset=()=>{incoming.value='';slot.innerHTML=[['A',byId.get(a.value)],['B',byId.get(b.value)]].flatMap(([side,t])=>t.players.map((id,i)=>`<option value="${side}:${i}">${side}: ${esc(names.get(id)||id)}</option>`)).join('');show();};
  a.onchange=reset;b.onchange=reset;slot.onchange=show;incoming.onchange=show;reset();
}

// Adapter for the local application: fetches the live model and renders it.
export function mountRapmUI({$,head,api,state}) {
  return {async rapmView(epoch) {
    const d=await api('rapm');
    if(epoch!==state.epoch)return;
    $('#main').innerHTML=head('Вклад игроков (RAPM)','Оценка вклада по исходам с поправкой на партнёров и соперников.',`<span class="tag orange">${d.series.status==='trained'?'ОБУЧЕНА НА СЕРИЯХ':'НЕТ ДАННЫХ'}</span>`)+'<div id="rapm-root"></div>';
    renderRapm($('#rapm-root'),d);
  }};
}
