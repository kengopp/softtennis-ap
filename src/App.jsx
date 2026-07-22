import { useState, useCallback, useEffect, useRef, Component } from "react";
import { supabase } from "./supabase-client";

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(error, errorInfo) { console.error("画面描画エラー:", error, errorInfo); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "red", fontSize: 13 }}>
          <b>エラーが発生しました</b><br/>
          {this.state.error?.message}
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// 定数
// ============================================================
const GAME_FORMATS = [5, 7, 9];
const MATCH_TYPES = [
  { key: "tournament", label: "公式大会" },
  { key: "practice",   label: "練習試合" },
  { key: "internal",   label: "部内戦"   },
];

// プレイ内容（ショット種別）
const PLAY_TYPES = [
  { key: "serve",    label: "サーブ"    },
  { key: "receive",  label: "レシーブ"  },
  { key: "volley",   label: "ボレー"    },
  { key: "smash",    label: "スマッシュ" },
  { key: "stroke",   label: "ストローク" },
  { key: "attack",   label: "アタック"  },
  { key: "shoot",    label: "シュート"  },
  { key: "lob",      label: "ロブ"      },
  { key: "drop",     label: "ドロップ"  },
];

// 結果（新規記録時の選択肢：決めた / 相手ミスの2択）
const RESULT_TYPES = [
  { key: "winner", label: "決めた",   is_winner: true  },
  { key: "error",  label: "相手ミス", is_winner: false },
];
// ラベル・勝敗判定（過去データに残る "ace" も正しく表示できるよう選択肢とは別管理。
// 「エース」は保護者など初見の利用者に伝わりにくいため、表示上は「決めた」に統一する）
const RESULT_LABELS    = { winner: "決めた", ace: "決めた", error: "相手ミス" };
const RESULT_IS_WINNER = { winner: true,        ace: true,    error: false   };

// フォア / バック
const SIDE_TYPES = [
  { key: "forehand", label: "フォア" },
  { key: "backhand",  label: "バック" },
];

// shot_typeキー（DB保存用：プレイ内容_結果 の組み合わせで生成）
const buildShotKey = (play, result) => play && result ? `${play}_${result}` : play ?? result ?? null;

const getPlayLabel   = (key) => PLAY_TYPES.find(p => p.key === key)?.label ?? key ?? "—";
const getResultLabel = (key) => RESULT_LABELS[key] ?? key ?? "";
const getSideLabel   = (key) => SIDE_TYPES.find(s => s.key === key)?.label ?? key ?? "";
const isWinnerResult = (result) => RESULT_IS_WINNER[result] ?? null;

const C = {
  navy:    "#0f2044",
  navyMid: "#1a3360",
  accent:  "#00c27a",
  accentL: "#e6faf3",
  orange:  "#f97316",
  red:     "#e53935",
  redL:    "#fdecea",
  purple:  "#6366f1",
  gray:    "#f4f6f9",
  border:  "#dde2ea",
  text:    "#1a2236",
  textSec: "#7a8499",
  white:   "#ffffff",
  teamA:   "#2ecc71",
  teamB:   "#f97316",
  serve:   "#fbbf24",
};

// ============================================================
// データ層（Supabase接続）
// ============================================================
const uid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  }));
const today  = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => iso ? iso.replace(/-/g, "/") : "";
// ★一覧等で試合の状態を短く表示するための共通ヘルパー（中断した試合を「進行中」と誤表示しないようにする）
const matchStatusShortLabel = (m) => m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : m.status==="abandoned" ? `途中終了 ${m.match_score_a}-${m.match_score_b}` : m.status==="suspended" ? `中断 ${m.match_score_a}-${m.match_score_b}` : "進行中";
// ★品質改善：「清見 祐吾」「清見祐吾」のように空白の有無だけが違う同一人物を
// 別選手として重複登録してしまわないよう、選手名の比較は空白を除去してから行う
const normalizePlayerName = (name) => (name || "").replace(/\s+/g, "");
const fmtDateRange = (start, end) => {
  if (!start) return "";
  const s = fmtDate(start);
  const e = end ? fmtDate(end) : s;
  return s === e ? s : `${s} 〜 ${e}`;
};

// ============================================================
// 統計集計用 共通ヘルパー
// ============================================================
// 指定選手が、この試合でどちら側(A/B)として出場したかを判定する。
// ★東福岡 対 東福岡 のような自チーム同士の練習試合の場合、B側の選手も自チームの一員なので、
// 　mySchoolNameを渡すことでB側の出場も対象に含められる（通常はteam A側のみを対象にする）
function ownSideFor(m, playerName, mySchoolName) {
  const onA = m.players.find(p=>p.player_name===playerName && p.team==="A");
  if (onA) return "A";
  if (mySchoolName) {
    const onB = m.players.find(p=>p.player_name===playerName && p.team==="B" && p.club_name && p.club_name.trim()===mySchoolName.trim());
    if (onB) return "B";
  }
  return null;
}
// 指定選手の視点で、その試合が勝ちかどうかを判定（出場していなければnull）
// ★この関数は常に自チーム選手の戦績を見る用途で使われるため、同名の選手が
// 　相手チームにも存在する場合の取り違えを防ぐよう、まず自チーム(A)側を優先して探す
// 　mySchoolNameを渡すと、自チーム同士の練習試合でB側に出た場合も対象にする
function winForPlayer(m, playerName, mySchoolName) {
  const team = ownSideFor(m, playerName, mySchoolName)
            ?? m.players.find(p=>p.player_name===playerName)?.team;
  if (!team) return null;
  return team==="A" ? m.match_score_a>m.match_score_b : m.match_score_b>m.match_score_a;
}
// 指定選手の、その試合での相方（ペア）名を取得
function partnerOf(m, playerName, mySchoolName) {
  const team = ownSideFor(m, playerName, mySchoolName)
            ?? m.players.find(p=>p.player_name===playerName)?.team;
  if (!team) return null;
  const partner = m.players.find(p=>p.team===team && p.player_name!==playerName);
  return partner ? partner.player_name : null;
}
// 試合配列から成績（試合数・勝敗・勝率）を算出
function recordOf(finishedMatches, winFn) {
  const total = finishedMatches.length;
  const wins = finishedMatches.filter(winFn).length;
  return { total, wins, losses: total-wins, rate: total>0 ? Math.round(wins/total*100) : 0 };
}
// 直近n日に絞り込み
function withinLastDays(matchList, days) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-days);
  return matchList.filter(m => m.match_date && new Date(m.match_date) >= cutoff);
}
// 期間チップ＋勝率ソートチップ（一覧画面で共通使用）
function PeriodSortBar({ period, setPeriod, sort, setSort }) {
  return (
    <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:12 }}>
      <button style={{ ...S.togBtn(period==="all",C.navy),fontSize:11,padding:"6px 10px" }} onClick={()=>setPeriod("all")}>全期間</button>
      <button style={{ ...S.togBtn(period==="month1",C.navy),fontSize:11,padding:"6px 10px" }} onClick={()=>setPeriod("month1")}>直近1ヶ月</button>
      <button style={{ ...S.togBtn(sort==="desc",C.accent),fontSize:11,padding:"6px 10px" }} onClick={()=>setSort("desc")}>勝率が高い順</button>
      <button style={{ ...S.togBtn(sort==="asc",C.accent),fontSize:11,padding:"6px 10px" }} onClick={()=>setSort("asc")}>勝率が低い順</button>
    </div>
  );
}
// 月別の勝率推移カード（複数画面で共通使用）
function MonthlyTrendCard({ finishedMatches, winFn, title="月別の勝率推移" }) {
  const byMonth = {};
  finishedMatches.forEach(m=>{
    const month = (m.match_date||"").slice(0,7);
    if (!month) return;
    (byMonth[month] ??= { wins:0, total:0 });
    byMonth[month].total++;
    if (winFn(m)) byMonth[month].wins++;
  });
  const months = Object.keys(byMonth).sort();
  if (months.length===0) return null;
  return (
    <div style={{ ...S.card, padding:16, marginBottom:16 }}>
      <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>{title}</div>
      {months.map(month=>{
        const { wins, total } = byMonth[month];
        const rate = Math.round(wins/total*100);
        const [y,mo] = month.split("-");
        return (
          <div key={month} style={{ marginBottom:10 }}>
            <div style={{ display:"flex",justifyContent:"space-between",fontSize:11,color:C.textSec,marginBottom:3 }}>
              <span>{y}年{Number(mo)}月（{total}試合）</span>
              <span style={{ fontWeight:700,color:C.text }}>{wins}勝{total-wins}敗・{rate}%</span>
            </div>
            <div style={{ height:8,background:"#e8edf3",borderRadius:4,overflow:"hidden" }}>
              <div style={{ width:`${rate}%`,height:"100%",background:C.accent,borderRadius:4 }}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// DBのshot_type制約に合う組み合わせのみ許可。合わなければnull（保存はできる）
const VALID_SHOT_TYPES = new Set([
  "serve_ace","volley_winner","smash_winner","stroke_winner","return_winner",
  "drop_winner","lob_winner","approach_winner","stroke_error","volley_error",
  "smash_error","return_error","drop_error","lob_error","net_cord","double_fault",
]);
const toShotType = (play, result) => {
  const key = buildShotKey(play, result);
  return VALID_SHOT_TYPES.has(key) ? key : null;
};

// ★トーナメント表の「簡易記録」（勝敗とスコアだけを直接入力したdraw_matches）を、
// 　選手別/ペア別の勝敗数集計に使えるよう「疑似的な試合」の形に変換して取得する。
// 　通常の試合記録（matchesテーブル）は一切作られないため、統計画面でのみこれを使う。
async function getSimpleRecordedDrawMatches() {
  const { data: dms, error } = await supabase
    .from("draw_matches")
    .select("id, tournament_id, side_a_entry_id, side_b_entry_id, simple_result_winner, simple_result_score_a, simple_result_score_b")
    .not("simple_result_winner", "is", null);
  if (error) { console.error(error); return []; }
  if (!dms || dms.length === 0) return [];

  const entryIds = Array.from(new Set(dms.flatMap(d => [d.side_a_entry_id, d.side_b_entry_id]).filter(Boolean)));
  const tournamentIds = Array.from(new Set(dms.map(d => d.tournament_id).filter(Boolean)));

  const [{ data: entries }, { data: tournaments }] = await Promise.all([
    entryIds.length ? supabase.from("draw_entries").select("id, player1_name, player2_name, school_name, is_own_team").in("id", entryIds) : Promise.resolve({ data: [] }),
    tournamentIds.length ? supabase.from("tournaments").select("id, name, start_date, end_date").in("id", tournamentIds) : Promise.resolve({ data: [] }),
  ]);
  const entryMap = {}; (entries ?? []).forEach(e => { entryMap[e.id] = e; });
  const tMap = {}; (tournaments ?? []).forEach(t => { tMap[t.id] = t; });

  return dms.map(dm => {
    const eA = dm.side_a_entry_id ? entryMap[dm.side_a_entry_id] : null;
    const eB = dm.side_b_entry_id ? entryMap[dm.side_b_entry_id] : null;
    const t = tMap[dm.tournament_id];
    const players = [];
    if (eA?.player1_name) players.push({ team: "A", player_name: eA.player1_name, club_name: eA.school_name || null, order_num: 1 });
    if (eA?.player2_name) players.push({ team: "A", player_name: eA.player2_name, club_name: eA.school_name || null, order_num: 2 });
    if (eB?.player1_name) players.push({ team: "B", player_name: eB.player1_name, club_name: eB.school_name || null, order_num: 1 });
    if (eB?.player2_name) players.push({ team: "B", player_name: eB.player2_name, club_name: eB.school_name || null, order_num: 2 });
    const hasScore = dm.simple_result_score_a != null && dm.simple_result_score_b != null;
    const scoreA = hasScore ? dm.simple_result_score_a : (dm.simple_result_winner === "A" ? 1 : 0);
    const scoreB = hasScore ? dm.simple_result_score_b : (dm.simple_result_winner === "B" ? 1 : 0);
    return {
      id: "draw-" + dm.id,
      tournament_name: t?.name || "",
      match_date: t?.start_date || t?.end_date || null,
      status: "finished",
      match_score_a: scoreA,
      match_score_b: scoreB,
      players,
      games: [],
      is_simple_draw_result: true,
    };
  }).filter(m => m.players.length > 0);
}

// ★複数の試合IDから、games/points/faultsまで含めた完全な試合データを一括取得する
// 　（個人分析画面で選ばれた複数の試合をまとめて集計するために使う）
async function getFullMatchesByIds(ids) {
  const uniqueIds = Array.from(new Set((ids ?? []).filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const [
    { data: ms, error: mErr },
    { data: playersData },
    { data: gamesData },
    { data: pointsData },
    { data: faultsData },
  ] = await Promise.all([
    supabase.from("matches").select("*").in("id", uniqueIds),
    supabase.from("match_players").select("*").in("match_id", uniqueIds),
    supabase.from("games").select("*").in("match_id", uniqueIds),
    supabase.from("points").select("*").in("match_id", uniqueIds),
    supabase.from("faults").select("*").in("match_id", uniqueIds),
  ]);
  if (mErr || !ms) { console.error(mErr); return []; }
  const playersByMatch = {}; (playersData ?? []).forEach(p => { (playersByMatch[p.match_id] ??= []).push(p); });
  const gamesByMatch = {}; (gamesData ?? []).forEach(g => { (gamesByMatch[g.match_id] ??= []).push(g); });
  const pointsByMatch = {}; (pointsData ?? []).forEach(pt => { (pointsByMatch[pt.match_id] ??= []).push(pt); });
  const faultsByMatch = {}; (faultsData ?? []).forEach(f => { (faultsByMatch[f.match_id] ??= []).push(f); });
  return ms.map(m => rowToMatchFull(
    m,
    playersByMatch[m.id] ?? [],
    gamesByMatch[m.id] ?? [],
    pointsByMatch[m.id] ?? [],
    faultsByMatch[m.id] ?? [],
  ));
}

// 指定選手が、この試合でどちら側（A/B）として出たかを踏まえて、その選手のスタッツを1件返す
function playerStatsInMatch(match, playerName, mySchoolName) {
  const side = ownSideFor(match, playerName, mySchoolName);
  if (!side) return null;
  const all = calcPlayerStats(match);
  return all.find(r => r.team === side && r.player_name === playerName) || null;
}

// 複数の試合をまたいで、指定選手のスタッツを合算する
function aggregatePlayerStats(fullMatches, playerName, mySchoolName) {
  const agg = {
    total: 0, winners: 0, errors: 0, plays: {}, playsWin: {}, playsErr: {},
    serveTotal: 0, serveFault: 0, receiveTotal: 0, receiveMiss: 0, matchesCounted: 0,
  };
  for (const m of fullMatches) {
    const s = playerStatsInMatch(m, playerName, mySchoolName);
    if (!s) continue;
    agg.matchesCounted++;
    agg.total += s.total; agg.winners += s.winners; agg.errors += s.errors;
    agg.serveTotal += s.serveTotal; agg.serveFault += s.serveFault;
    agg.receiveTotal += s.receiveTotal; agg.receiveMiss += s.receiveMiss;
    for (const k in s.plays)    agg.plays[k]    = (agg.plays[k]    ?? 0) + s.plays[k];
    for (const k in s.playsWin) agg.playsWin[k] = (agg.playsWin[k] ?? 0) + s.playsWin[k];
    for (const k in s.playsErr) agg.playsErr[k] = (agg.playsErr[k] ?? 0) + s.playsErr[k];
  }
  return agg;
}
// 合算スタッツから、画面表示用の主要指標（%）を計算する
function keyRatesFromAgg(agg) {
  return {
    serveRate: agg.serveTotal > 0 ? Math.round((1 - agg.serveFault / agg.serveTotal) * 100) : null,
    receiveMissRate: agg.receiveTotal > 0 ? Math.round(agg.receiveMiss / agg.receiveTotal * 100) : null,
    decisionRate: agg.total > 0 ? Math.round(agg.winners / agg.total * 100) : null,
  };
}


async function getMatches() {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return []; }
  if (data.length === 0) return [];

  const matchIds = data.map(m => m.id);
  const [
    { data: playersData, error: playersErr },
    { data: gamesData,   error: gamesErr },
    { data: pointsData,  error: pointsErr },
  ] = await Promise.all([
    supabase.from("match_players").select("*").in("match_id", matchIds).order("team").order("order_num"),
    supabase.from("games").select("*").in("match_id", matchIds).order("game_number"),
    supabase.from("points").select("match_id,game_id,scoring_team,score_a_after,score_b_after,point_number").in("match_id", matchIds),
  ]);
  if (playersErr) console.error(playersErr);
  if (gamesErr)   console.error(gamesErr);
  if (pointsErr)  console.error(pointsErr);

  const playersByMatch = {};
  (playersData ?? []).forEach(p => { (playersByMatch[p.match_id] ??= []).push(p); });

  const gamesByMatch = {};
  (gamesData ?? []).forEach(g => { (gamesByMatch[g.match_id] ??= []).push(g); });

  const pointsByGame = {};
  (pointsData ?? []).forEach(pt => { (pointsByGame[pt.game_id] ??= []).push(pt); });

  return data.map(m => {
    const games = (gamesByMatch[m.id] ?? []).map(g => ({
      ...g,
      points: (pointsByGame[g.id] ?? []).sort((a,b) => a.point_number - b.point_number),
    }));
    return rowToMatchSummary(m, playersByMatch[m.id] ?? [], games);
  });
}

// 試合1件を、関連テーブルすべて含めて取得
async function getMatch(id) {
  if (!id) return null;
  const { data: m, error } = await supabase.from("matches").select("*").eq("id", id).single();
  if (error || !m) { console.error(error); return null; }

  const [
    { data: players, error: playersErr },
    { data: games, error: gamesErr },
    { data: points, error: pointsErr },
    { data: faults, error: faultsErr },
  ] = await Promise.all([
    supabase.from("match_players").select("*").eq("match_id", id).order("team").order("order_num"),
    supabase.from("games").select("*").eq("match_id", id).order("game_number"),
    supabase.from("points").select("*").eq("match_id", id).order("point_number"),
    supabase.from("faults").select("*").eq("match_id", id).order("fault_number"),
  ]);
  // ★重要：ここでエラーを握りつぶして空配列のまま先に進めてしまうと、
  // 　その後に何らかの保存操作（メモ編集・中断/途中終了フラグなど）が行われた際、
  // 　saveMatch()の「クライアント側に無い行を削除する」処理により、
  // 　本当は存在していたgames/points/faultsが誤って全削除されてしまう危険がある。
  // 　そのため、一部でも取得に失敗した場合はここで確実にエラーにする。
  const fetchErr = playersErr || gamesErr || pointsErr || faultsErr;
  if (fetchErr) { console.error(fetchErr); throw new Error("試合データの取得に失敗しました。再読み込みしてください。"); }

  return rowToMatchFull(m, players ?? [], games ?? [], points ?? [], faults ?? []);
}

function rowToMatchSummary(m, players=[], games=[]) {
  return {
    id: m.id, created_by: m.created_by,
    match_date: m.match_date, venue: m.venue ?? "",
    tournament_name: m.tournament_name ?? "", round: m.round ?? "",
    match_type: m.match_type, game_format: m.game_format,
    is_doubles: m.is_doubles, first_server: m.first_server, status: m.status,
    match_score_a: m.match_score_a, match_score_b: m.match_score_b,
    memo: m.memo ?? "",
    court_number: m.court_number ?? "",
    is_younger: m.is_younger === true,
    players: players.map(p => ({
      id: p.id, team: p.team, player_name: p.player_name,
      club_name: p.club_name ?? "", position: p.position ?? "", order_num: p.order_num,
    })),
    games: games.map(g => ({
      id: g.id, game_number: g.game_number, is_final: g.is_final,
      score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team,
      points: g.points ?? [],
    })),
  };
}

function rowToMatchFull(m, players, games, points, faults) {
  return {
    id: m.id, created_by: m.created_by,
    match_date: m.match_date, venue: m.venue ?? "",
    tournament_name: m.tournament_name ?? "", round: m.round ?? "",
    match_type: m.match_type, game_format: m.game_format,
    is_doubles: m.is_doubles, first_server: m.first_server, status: m.status,
    match_score_a: m.match_score_a, match_score_b: m.match_score_b,
    memo: m.memo ?? "",
    court_number: m.court_number ?? "",
    is_younger: m.is_younger === false ? false : true,
    players: players.map(p => ({
      id: p.id, team: p.team, player_name: p.player_name,
      club_name: p.club_name ?? "", position: p.position ?? "", order_num: p.order_num,
    })),
    games: games.map(g => ({
      id: g.id, match_id: m.id, game_number: g.game_number, server_team: g.server_team,
      is_final: g.is_final, score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team,
      faults: faults.filter(f => f.game_id === g.id).map(f => ({
        id: f.id, game_id: f.game_id, match_id: m.id, fault_number: f.fault_number,
        server_team: f.server_team, player_name: f.player_name,
        score_a_at: f.score_a_at, score_b_at: f.score_b_at,
      })),
      points: points.filter(pt => pt.game_id === g.id).map(pt => ({
        id: pt.id, game_id: pt.game_id, match_id: m.id, point_number: pt.point_number,
        scoring_team: pt.scoring_team, player_name: pt.player_name,
        play_type: pt.play_type ?? null, side_type: pt.side_type ?? null, result_type: pt.result_type ?? null,
        is_winner: pt.is_winner, fault_count: pt.fault_count ?? 0, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
        scored_at: pt.scored_at ?? null, // ★動画同期用：得点を記録した時刻
      })),
    })),
  };
}

// 試合1件を関連テーブルごと保存（新規・更新どちらも対応）
async function saveMatch(match) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");

  const matchRow = {
    id: match.id, created_by: (match.created_by && match.created_by !== "me") ? match.created_by : user.id,
    match_date: match.match_date, venue: match.venue || null,
    tournament_name: match.tournament_name || null, round: match.round || null,
    match_type: match.match_type, game_format: match.game_format,
    is_doubles: match.is_doubles, first_server: match.first_server, status: match.status,
    match_score_a: match.match_score_a, match_score_b: match.match_score_b,
    memo: match.memo || null,
    court_number: match.court_number || null,
    is_younger: match.is_younger !== false,
  };
  const { error: mErr } = await supabase.from("matches").upsert(matchRow);
  if (mErr) throw mErr;

  // 選手情報：一旦削除してから入れ直す（シンプルで確実な方式）
  // ★安全装置：本来選手が登録されているはずの試合で、保存内容の選手が0人の場合は
  // 　取得エラー等で空のまま読み込んでしまった可能性が高いため、削除をスキップして実データを保護する
  const { data: existingPlayers } = await supabase.from("match_players").select("id").eq("match_id", match.id);
  const playersLooksLikeAccidentalWipe = !(match.players?.length) && (existingPlayers ?? []).length > 0;
  if (playersLooksLikeAccidentalWipe) {
    console.error("saveMatch: 既存のmatch_playersがあるのに保存内容が空のため、削除処理をスキップしました。match_id=", match.id);
  } else {
    await supabase.from("match_players").delete().eq("match_id", match.id);
    if (match.players?.length) {
      const playerRows = match.players.map(p => ({
        id: p.id, match_id: match.id, team: p.team, player_name: p.player_name,
        club_name: p.club_name || null, position: p.position || null, order_num: p.order_num,
      }));
      const { error: pErr } = await supabase.from("match_players").insert(playerRows);
      if (pErr) throw pErr;
    }
  }

  // ゲーム・ポイント・フォルト：
  // ★以前は「全部削除→全部挿入」の順で処理していたが、連続でスコア登録が走ると
  // 　保存の合間に「ポイントはあるがその親のゲーム行がまだ存在しない」瞬間ができてしまい、
  // 　外部キー制約違反（points_game_id_fkey）でエラーになることがあった。
  // 　そのため、先に現在の内容をすべて保存（upsert）し、その後で
  // 　クライアント側に無くなった（削除された）行だけを掃除する順番に変更。
  for (const g of (match.games ?? [])) {
    const gameRow = {
      id: g.id, match_id: match.id, game_number: g.game_number, server_team: g.server_team,
      is_final: g.is_final, score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team || null,
    };
    const { error: gErr } = await supabase.from("games").upsert(gameRow);
    if (gErr) throw gErr;

    if (g.points?.length) {
      const pointRows = g.points.map(pt => ({
        id: pt.id, game_id: g.id, match_id: match.id, point_number: pt.point_number,
        scoring_team: pt.scoring_team, player_name: pt.player_name || null,
        shot_type: toShotType(pt.play_type, pt.result_type),
        play_type: pt.play_type || null, side_type: pt.side_type || null, result_type: pt.result_type || null,
        is_winner: pt.is_winner, fault_count: pt.fault_count ?? 0, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
        scored_at: pt.scored_at || null, // ★動画同期用：得点を記録した時刻
      }));
      const { error: ptErr } = await supabase.from("points").upsert(pointRows);
      if (ptErr) throw ptErr;
    }
    if (g.faults?.length) {
      const faultRows = g.faults.map(f => ({
        id: f.id, game_id: g.id, match_id: match.id, fault_number: f.fault_number,
        server_team: f.server_team, player_name: f.player_name || null,
        score_a_at: f.score_a_at, score_b_at: f.score_b_at,
      }));
      const { error: fErr } = await supabase.from("faults").upsert(faultRows);
      if (fErr) throw fErr;
    }
  }

  // クライアント側に存在しなくなった行（1点前に戻す、修正で削除、等）だけを後から掃除する
  const currentGameIds = (match.games ?? []).map(g => g.id);
  const currentPointIds = (match.games ?? []).flatMap(g => (g.points ?? []).map(p => p.id));
  const currentFaultIds = (match.games ?? []).flatMap(g => (g.faults ?? []).map(f => f.id));

  const { data: existingGames } = await supabase.from("games").select("id").eq("match_id", match.id);

  // ★安全装置：本来ゲームが存在するはずの試合で、今回保存しようとしている内容にゲームが
  // 　1件も無い場合、それは「取得エラーなどで空のまま読み込んでしまった」可能性が高い。
  // 　このケースで無条件に削除処理を走らせると、既存のgames/points/faultsが全消失してしまうため、
  // 　スコアを本当にゼロへ戻したい場合は必ずresetMatchToUnrecorded()の専用フローを使う前提とし、
  // 　ここでは削除をスキップして実データを保護する。
  const looksLikeAccidentalWipe = currentGameIds.length === 0 && (existingGames ?? []).length > 0;

  if (!looksLikeAccidentalWipe) {
    const { data: existingPoints } = await supabase.from("points").select("id").eq("match_id", match.id);
    const stalePointIds = (existingPoints ?? []).map(r => r.id).filter(id => !currentPointIds.includes(id));
    if (stalePointIds.length) await supabase.from("points").delete().in("id", stalePointIds);

    const { data: existingFaults } = await supabase.from("faults").select("id").eq("match_id", match.id);
    const staleFaultIds = (existingFaults ?? []).map(r => r.id).filter(id => !currentFaultIds.includes(id));
    if (staleFaultIds.length) await supabase.from("faults").delete().in("id", staleFaultIds);

    const staleGameIds = (existingGames ?? []).map(r => r.id).filter(id => !currentGameIds.includes(id));
    if (staleGameIds.length) await supabase.from("games").delete().in("id", staleGameIds);
  } else {
    console.error("saveMatch: 既存のgamesがあるのに保存内容が空のため、削除処理をスキップしました。match_id=", match.id);
  }
}

// ★誤削除対策のため、即時完全削除ではなくゴミ箱行き（論理削除）にする
async function deleteMatch(id) {
  const { error } = await supabase.from("matches").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

// ★「結果だけ記録」で終えた試合を、後からポイントごとの詳細記録に切り替えたい時に使う。
//   既存のgames/points/faultsを消し、スコアと状態を未開始に戻す（recorder_idも解放する）。
async function resetMatchToUnrecorded(matchId) {
  const { data: existingGames } = await supabase.from("games").select("id").eq("match_id", matchId);
  const gameIds = (existingGames ?? []).map(g => g.id);
  if (gameIds.length) {
    await supabase.from("points").delete().in("game_id", gameIds);
    await supabase.from("faults").delete().in("game_id", gameIds);
    await supabase.from("games").delete().in("id", gameIds);
  }
  await supabase.from("matches").update({ match_score_a:0, match_score_b:0, status:"waiting" }).eq("id", matchId);
}

// ゴミ箱に入っている（個人戦の）試合一覧を取得（軽量：明細は含めない）
async function getDeletedMatches() {
  const { data, error } = await supabase
    .from("matches")
    .select("id, match_date, tournament_name, match_score_a, match_score_b, deleted_at")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data ?? [];
}
async function restoreMatch(id) {
  const { error } = await supabase.from("matches").update({ deleted_at: null }).eq("id", id);
  if (error) throw error;
}
async function permanentlyDeleteMatch(id) {
  const { error } = await supabase.from("matches").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// 動画レビュー（match_videos / video_sync_anchors）
// ============================================================
// 指定した試合に登録されている動画（情報のみ。実体のファイルはスマホ内のまま）を取得
async function getMatchVideos(matchId) {
  const { data, error } = await supabase.from("match_videos").select("*").eq("match_id", matchId).order("created_at");
  if (error) { console.error(error); return []; }
  return data ?? [];
}

// 動画1件の登録（初回選択時）。まだ同期はしていない状態
async function saveMatchVideo(row) {
  const payload = {
    id: row.id, match_id: row.match_id,
    video_source_type: row.video_source_type || "local",
    video_reference: row.video_reference || null,
    file_name: row.file_name || null,
    duration_sec: row.duration_sec ?? null,
  };
  const { error } = await supabase.from("match_videos").upsert(payload);
  if (error) throw error;
}

async function deleteMatchVideo(id) {
  const { error } = await supabase.from("match_videos").delete().eq("id", id);
  if (error) throw error;
}

// 指定の動画に設定されている同期アンカーを取得（現状は動画1本につき1件＝1点目の位置合わせ）
async function getSyncAnchor(matchVideoId) {
  const { data, error } = await supabase.from("video_sync_anchors").select("*").eq("match_video_id", matchVideoId).order("created_at", { ascending:false }).limit(1);
  if (error) { console.error(error); return null; }
  return data?.[0] ?? null;
}

// 同期アンカーの保存（既存があれば置き換える＝常に最新の同期状態のみ保持）
async function saveSyncAnchor(matchVideoId, matchId, { pointId, gameNo, scoredAt, videoSec }) {
  await supabase.from("video_sync_anchors").delete().eq("match_video_id", matchVideoId);
  const { error } = await supabase.from("video_sync_anchors").insert({
    id: uid(), match_video_id: matchVideoId, match_id: matchId,
    point_id: pointId || null, game_no: gameNo ?? null,
    scored_at: scoredAt || null, video_sec: videoSec, anchor_type: "manual",
  });
  if (error) throw error;
}

// 予定 → 進行中に切り替え
async function startScheduledMatch(id, firstServer) {
  const updates = { status:"active" };
  if (firstServer) updates.first_server = firstServer;
  const { error } = await supabase.from("matches").update(updates).eq("id", id);
  if (error) throw error;
}

// ============================================================
// プロフィール
// ============================================================
async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("users").select("*").eq("id", user.id).single();
  if (error) { console.error(error); return null; }
  // ★school_name が空のまま保存されてしまっていた場合に備え、読み込み時に自動修復する
  if (data && data.school_id && !data.school_name) {
    const { data: schoolRow } = await supabase.from("schools").select("name").eq("id", data.school_id).single();
    if (schoolRow?.name) {
      await supabase.from("users").update({ school_name: schoolRow.name }).eq("id", user.id);
      data.school_name = schoolRow.name;
    }
  }
  return data;
}

// プロフィール画像（LINEのような丸アイコン）
async function uploadAvatarImage(file) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${user.id}/${uid()}.${ext}`;
  const { error: upErr } = await supabase.storage.from("avatars").upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}
async function updateMyAvatar(avatarUrl) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const { error } = await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", user.id);
  if (error) throw error;
}

async function saveMyProfile(profile) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  if (!profile.school_id) throw new Error("学校を選択してください。");

  // ★usersテーブルの school_name は NOT NULL 制約があるため、school_id から必ず引いてセットする。
  // 取得できなかった場合は空文字でごまかさず、はっきりエラーにして呼び出し元に伝える。
  const { data: schoolRow, error: schoolError } = await supabase
    .from("schools")
    .select("name")
    .eq("id", profile.school_id)
    .single();
  if (schoolError || !schoolRow) {
    throw new Error("学校情報を取得できませんでした。もう一度学校を選択してください。");
  }

  const updates = {
    id: user.id,
    name: profile.name,
    school_id: profile.school_id,
    school_name: schoolRow.name,
    prefecture: profile.prefecture,
    category: profile.category,
    gender_category: profile.gender_category,
    linked_player_id: profile.linked_player_id ?? null,
  };
  if (profile.is_approved !== undefined) updates.is_approved = profile.is_approved;
  // ★update だと usersテーブルに行がまだ存在しない場合、0件更新のままエラーも出さずに終わってしまい、
  // 保存できたように見えて実は何も保存されていない、という無限ループの原因になっていた。
  // upsert にすることで、行がなければ新規作成、あれば更新、のどちらでも確実に保存されるようにする。
  const { error } = await supabase.from("users").upsert(updates);
  if (error) {
    console.error(error);
    throw error;
  }
}

// 招待コード・管理者情報を取得
async function getSchoolInviteInfo(schoolId) {
  if (!schoolId) return null;
  const { data, error } = await supabase.from("schools").select("invite_code, admin_user_id").eq("id", schoolId).single();
  if (error) { console.error(error); return null; }
  return data;
}

// 招待コードを照合
async function verifyInviteCode(schoolId, code) {
  const info = await getSchoolInviteInfo(schoolId);
  if (!info) return false;
  return info.invite_code === code.trim().toUpperCase();
}

// 招待コードを再発行
async function reissueInviteCode(schoolId) {
  const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { error } = await supabase.from("schools").update({ invite_code: newCode }).eq("id", schoolId);
  if (error) throw error;
  return newCode;
}

// 承認済みメンバー一覧を取得（移譲先選択用）
async function getApprovedMembers() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase.from("users").select("id, name").eq("is_approved", true);
  if (error) { console.error(error); return []; }
  return (data || []).filter(m => m.id !== user.id);
}

// グループ参加者一覧を取得（自分含む全員）
async function getGroupMembers() {
  const { data, error } = await supabase.from("users").select("id, name, is_approved, avatar_url").eq("is_approved", true).order("name");
  if (error) { console.error(error); return []; }
  return data || [];
}

// 管理者を移譲
async function transferAdmin(schoolId, toUserId) {
  const { error } = await supabase.from("schools").update({ admin_user_id: toUserId }).eq("id", schoolId);
  if (error) throw error;
}

// チームを解散（全データ削除）
async function dissolveTeam() {
  const { error } = await supabase.rpc("dissolve_team");
  if (error) throw error;
}

// ============================================================
// 学校マスター（閲覧は誰でも可、追加・編集・削除は管理者のみ）
// ============================================================
// ★品質改善：学校マスターは追加・編集・削除以外ではほぼ変化しない「参照データ」なので、
// 毎回の一覧再読み込み（reload）のたびにネットワーク取得していたのをやめ、
// 一度取得したらメモリ上にキャッシュして使い回す。追加・編集・削除時だけキャッシュを破棄する。
let __schoolsCache = null;
let __schoolsRequestVersion = 0; // ★通信競合対策：古いリクエストの結果でキャッシュを上書きしないようにする
async function getSchools(force=false) {
  if (__schoolsCache && !force) return __schoolsCache;
  const requestVersion = ++__schoolsRequestVersion;
  const { data, error } = await supabase.from("schools").select("*").order("name");
  if (error) {
    console.error("学校一覧の取得に失敗しました:", error);
    // ★管理画面（force=true）は「今のDBの正しい状態」を見る場所なので、
    //   通信に失敗した時に古いキャッシュを返してしまうと誤った情報を正しいものとして見せてしまう。
    //   そのため force=true の時は握りつぶさず例外を投げ、呼び出し側でエラー表示させる。
    if (force) throw error;
    return __schoolsCache || [];
  }
  const list = data || [];
  // 途中で別のgetSchools呼び出しが走っていた場合、後から返ってきた古いリクエストの結果で
  // 新しいキャッシュを上書きしてしまわないようにする
  if (requestVersion === __schoolsRequestVersion) __schoolsCache = list;
  return list;
}
function invalidateSchoolsCache() { __schoolsCache = null; __schoolsRequestVersion += 1; }

async function addSchool(name, prefecture, category, genderRestriction) {
  const trimmedName = name?.trim();
  if (!trimmedName) throw new Error("学校名を入力してください。");
  const row = { id: uid(), name: trimmedName, prefecture: prefecture || null, category: category || null, gender_restriction: genderRestriction || "mixed" };
  const { data, error } = await supabase.from("schools").insert(row).select("*").single();
  if (error) throw error;
  invalidateSchoolsCache();
  return data; // ★DBが実際に保存した内容（created_at等のデフォルト値も含む）を返す
}

async function updateSchoolMaster(id, updates) {
  const { data, error } = await supabase.from("schools").update(updates).eq("id", id).select("*");
  if (error) throw error;
  if (!data || data.length===0) throw new Error("更新対象の学校が見つからないか、更新権限がありません。");
  invalidateSchoolsCache();
  return data[0];
}

// ★チーム共通の目標設定（学校＝チーム単位で1セットのみ保持）
async function getSchoolGoals(schoolId) {
  if (!schoolId) return null;
  const { data, error } = await supabase.from("schools")
    .select("goal_first_serve_pct, goal_receive_miss_pct, goal_winner_count, goal_error_count, goal_point_diff")
    .eq("id", schoolId).single();
  if (error) { console.error(error); return null; }
  return data;
}

async function deleteSchoolMaster(id) {
  const { data, error } = await supabase.from("schools").delete().eq("id", id).select("id, name");
  if (error) throw error;
  if (!data || data.length===0) throw new Error("削除対象の学校が見つからないか、削除権限がありません。");
  invalidateSchoolsCache();
  return data[0];
}

// ============================================================
// 選手マスター（同じ学校のメンバーで共有）
// ============================================================
async function getPlayerRoster() {
  const { data, error } = await supabase.from("players").select("*").order("player_name");
  if (error) { console.error(error); return []; }
  return data;
}

// 試合保存時に選手を選手マスターへ自動登録する
// 同じ名前がすでにある場合は「田中 蓮2」「田中 蓮3」のように連番をつける
async function autoRegisterPlayerToRoster(playerName, teamName, isOwnTeam) {
  if (!playerName?.trim()) return;
  try {
    const roster = await getPlayerRoster();
    const baseName = playerName.trim();
    // ★品質改善：空白の有無だけが違う同一人物を別選手として重複登録しないよう、
    // 既存名との比較は空白を除去して行う
    const existingNames = new Set(roster.map(p => normalizePlayerName(p.player_name)));
    // すでに（空白の違いを除いて）完全一致する名前がある場合はスキップ
    if (existingNames.has(normalizePlayerName(baseName))) return;
    // 連番チェック（「田中 蓮2」「田中 蓮3」などがある場合に次の番号を使う）
    let finalName = baseName;
    let n = 2;
    while (existingNames.has(normalizePlayerName(finalName))) {
      finalName = `${baseName}${n}`;
      n++;
    }
    await savePlayer({ player_name: finalName, is_own_team: isOwnTeam, team_name: teamName || null });
  } catch (e) {
    console.error("選手マスター自動登録エラー:", e);
  }
}

async function savePlayer(player) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  // school_id / gender_category は呼び出し元から明示的に渡された値を優先する
  // （新規登録フローでは、この時点でまだ自分のプロフィールがDBに保存されていないことがあるため）
  let schoolId = player.school_id;
  let genderCategory = player.gender_category;
  if (schoolId === undefined || genderCategory === undefined) {
    const profile = await getMyProfile();
    if (schoolId === undefined) schoolId = profile?.school_id || null;
    if (genderCategory === undefined) genderCategory = profile?.gender_category || null;
  }
  const row = {
    id: player.id || uid(),
    school_id: schoolId || null,
    gender_category: genderCategory || null,
    player_name: player.player_name,
    position: player.position || null,
    dominant_hand: player.dominant_hand || null,
    is_own_team: player.is_own_team === true,
    team_name: player.team_name || null,
    created_by: user.id,
  };
  const { error } = await supabase.from("players").upsert(row);
  if (error) throw error;
  return row;
}

// ★品質改善：ユーザーの「関連選手」として紐づいたままの選手を削除しようとすると、
// 外部キー制約に阻まれて削除できないことがあった。
// クライアント側から他のユーザーの linked_player_id を直接更新しようとしても、
// RLS（自分の行しか更新できない制限）に阻まれて実際には解除されないケースがあったため、
// 紐づけ解除＋削除をまとめてDB側（Postgres関数）で安全に行う。
// ★選手マスターで選手名を変更した時、過去の試合記録（match_players/points/faults）にも反映する。
// 　同姓の別選手（相手チームなど）を誤って巻き込まないよう、対象を絞り込んでから更新する。
// 　戻り値は更新した試合数（0件やエラーの場合は原因を呼び出し元で分かるようにする）。
async function renamePlayerEverywhere(oldName, newName, team, clubName) {
  if (!oldName || !newName || oldName === newName) return 0;
  let q = supabase.from("match_players").select("id, match_id, club_name").eq("player_name", oldName);
  if (team) q = q.eq("team", team);
  const { data: rows, error: selErr } = await q;
  if (selErr) throw selErr;
  let targets = rows ?? [];
  if (clubName) targets = targets.filter(r => (r.club_name || "").trim() === clubName.trim());
  if (targets.length === 0) return 0;
  const matchPlayerIds = targets.map(r => r.id);
  const matchIds = Array.from(new Set(targets.map(r => r.match_id)));
  const { error: mpErr } = await supabase.from("match_players").update({ player_name: newName }).in("id", matchPlayerIds);
  if (mpErr) throw mpErr;
  const { error: ptErr } = await supabase.from("points").update({ player_name: newName }).eq("player_name", oldName).in("match_id", matchIds);
  if (ptErr) throw ptErr;
  const { error: flErr } = await supabase.from("faults").update({ player_name: newName }).eq("player_name", oldName).in("match_id", matchIds);
  if (flErr) throw flErr;
  return matchIds.length;
}

async function deletePlayerFromRoster(id) {
  const { error } = await supabase.rpc("delete_player_and_unlink", { p_player_id: id });
  if (error) throw error;
}

// ============================================================
// 学校名サジェスト（誤入力防止のための候補一覧）
// 学校マスター ＋ これまで試合で入力されたチーム名 を候補にする
// （試合のチーム名欄は相手チームなど自由入力も許可するための候補リスト）
// 都道府県で絞り込めるよう、学校マスター由来のものは prefecture を保持する
// ============================================================
// 過去の試合に入力された会場名の候補一覧を取得
async function getKnownVenues() {
  try {
    const { data, error } = await supabase.from("matches").select("venue");
    if (error) { console.error("venue fetch error:", error); return []; }
    return [...new Set((data ?? []).map(r => r.venue).filter(Boolean))].sort();
  } catch(e) { console.error("getKnownVenues exception:", e); return []; }
}

async function getKnownSchools() {
  const [{ data: schoolsData, error: schoolsErr }, { data: cpData, error: cpErr }] = await Promise.all([
    supabase.from("schools").select("name, prefecture"),
    supabase.from("match_players").select("club_name"),
  ]);
  if (schoolsErr) console.error(schoolsErr);
  if (cpErr) console.error(cpErr);
  const map = new Map(); // name -> prefecture（学校マスター由来を優先）
  (cpData ?? []).forEach(r => { if (r.club_name && !map.has(r.club_name)) map.set(r.club_name, null); });
  (schoolsData ?? []).forEach(r => { if (r.name) map.set(r.name, r.prefecture || null); });
  return Array.from(map.entries())
    .map(([name, prefecture]) => ({ name, prefecture }))
    .sort((a,b)=>a.name.localeCompare(b.name,"ja"));
}

// ============================================================
// 団体戦データ層
// ============================================================
async function getTeamMatches() {
  const { data, error } = await supabase
    .from("team_matches")
    .select("*")
    .is("deleted_at", null)
    .order("match_date", { ascending: false });
  if (error) { console.error(error); return []; }
  if (!data || data.length === 0) return [];

  const ids = data.map(m => m.id);
  const { data: games, error: gErr } = await supabase
    .from("team_match_games")
    .select("*")
    .in("team_match_id", ids)
    .order("order_num");
  if (gErr) console.error(gErr);

  const gamesByTeamMatch = {};
  (games ?? []).forEach(g => { (gamesByTeamMatch[g.team_match_id] ??= []).push(g); });

  return data.map(m => ({
    ...m,
    games: gamesByTeamMatch[m.id] ?? [],
  }));
}

async function getTeamMatch(id) {
  const { data: m, error } = await supabase.from("team_matches").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error || !m) { if (error) console.error(error); return null; }
  const { data: games } = await supabase.from("team_match_games").select("*").eq("team_match_id", id).order("order_num");
  return { ...m, games: games ?? [] };
}

// ★品質改善（フェーズ2）：自動更新のたびに毎回すべてを取り直すのではなく、
// まず「そもそも何か変わったか」だけを軽量に確認する。
// team_match_games（番手ごとの状態）と、紐づくmatches（試合そのもののスコア）の
// updated_at のうち一番新しいものを見て、前回確認時と同じなら「変化なし」と判断できる。
async function getTeamMatchChangeSignature(teamMatchId, matchIds) {
  const [{ data: games, error: gamesErr }, matchesRes] = await Promise.all([
    supabase.from("team_match_games").select("id, match_id, status, updated_at").eq("team_match_id", teamMatchId),
    (matchIds && matchIds.length > 0)
      ? supabase.from("matches").select("id, match_score_a, match_score_b, status, updated_at").in("id", matchIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (gamesErr) console.error(gamesErr);
  if (matchesRes?.error) console.error(matchesRes.error);

  // updated_atだけに依存すると、DBトリガー未設定・同一秒更新・一部テーブル未更新の環境で
  // 変更を取り逃がす可能性があるため、スコア・状態も含めた軽量シグネチャにする。
  const gamePart = (games || [])
    .map(g => `${g.id}:${g.match_id || ""}:${g.status || ""}:${g.updated_at || ""}`)
    .sort()
    .join("|");
  const matchPart = ((matchesRes && matchesRes.data) || [])
    .map(m => `${m.id}:${m.match_score_a ?? 0}:${m.match_score_b ?? 0}:${m.status || ""}:${m.updated_at || ""}`)
    .sort()
    .join("|");
  return `${gamePart}#${matchPart}`;
}

async function saveTeamMatch(tm) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const row = {
    id: tm.id || uid(),
    created_by: tm.created_by || user.id,
    match_date: tm.match_date || null,
    venue: tm.venue || null,
    tournament_name: tm.tournament_name || null,
    round: tm.round || null,
    my_school_id: tm.my_school_id || null,
    my_team_division: tm.my_team_division || null,
    opponent_name: tm.opponent_name || null,
    opponent_division: tm.opponent_division || null,
    format: tm.format || "best2",
    status: tm.status || "scheduled",
    my_score: tm.my_score ?? 0,
    opponent_score: tm.opponent_score ?? 0,
    court_number: tm.court_number || null,
    is_younger: tm.is_younger !== false,
  };
  const { error } = await supabase.from("team_matches").upsert(row);
  if (error) throw error;
  return row;
}

// ★誤削除対策のため、即時完全削除ではなくゴミ箱行き（論理削除）にする。
//   団体戦本体だけでなく、各番手が参照しているmatches行も一緒に論理削除しないと、
//   「団体戦は削除済みなのに、その番手のmatches行だけ進行中のまま残る」という不整合が起きる。
async function deleteTeamMatch(id) {
  const { data: games } = await supabase.from("team_match_games").select("match_id").eq("team_match_id", id);
  const matchIds = (games ?? []).map(g => g.match_id).filter(Boolean);
  if (matchIds.length > 0) {
    await supabase.from("matches").update({ deleted_at: new Date().toISOString() }).in("id", matchIds);
  }
  const { error } = await supabase.from("team_matches").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

async function getDeletedTeamMatches() {
  const { data, error } = await supabase
    .from("team_matches")
    .select("id, match_date, tournament_name, opponent_name, my_score, opponent_score, deleted_at")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data ?? [];
}
async function restoreTeamMatch(id) {
  const { data: games } = await supabase.from("team_match_games").select("match_id").eq("team_match_id", id);
  const matchIds = (games ?? []).map(g => g.match_id).filter(Boolean);
  if (matchIds.length > 0) {
    await supabase.from("matches").update({ deleted_at: null }).in("id", matchIds);
  }
  const { error } = await supabase.from("team_matches").update({ deleted_at: null }).eq("id", id);
  if (error) throw error;
}
async function permanentlyDeleteTeamMatch(id) {
  const { error } = await supabase.from("team_matches").delete().eq("id", id);
  if (error) throw error;
}

async function saveTeamMatchGame(g) {
  const row = {
    id: g.id || uid(),
    team_match_id: g.team_match_id,
    order_num: g.order_num,
    match_id: g.match_id || null,
    recorder_id: g.recorder_id || null,
    recorder_name: g.recorder_name || null,
    status: g.status || "waiting",
  };
  const { error } = await supabase.from("team_match_games").upsert(row);
  if (error) throw error;
  return row;
}

async function updateTeamMatchGame(id, updates) {
  const { error } = await supabase.from("team_match_games").update(updates).eq("id", id);
  if (error) throw error;
}

// 団体戦の勝敗スコアを再集計してDBを更新
async function recalcTeamMatchScore(teamMatchId) {
  const { data: games, error: gamesErr } = await supabase
    .from("team_match_games")
    .select("id, match_id, status")
    .eq("team_match_id", teamMatchId);
  if (gamesErr) { console.error(gamesErr); return null; }
  if (!games) return null;

  const matchIds = games.filter(g => g.match_id).map(g => g.match_id);
  if (matchIds.length === 0) return null;

  const [{ data: matches, error: matchesErr }, { data: tm, error: tmErr }] = await Promise.all([
    supabase.from("matches").select("id,match_score_a,match_score_b,status").in("id", matchIds),
    supabase.from("team_matches").select("format,my_score,opponent_score,status").eq("id", teamMatchId).single(),
  ]);
  if (matchesErr) { console.error(matchesErr); return null; }
  if (tmErr) { console.error(tmErr); return null; }
  if (!matches || !tm) return null;

  const matchMap = {};
  matches.forEach(m => { matchMap[m.id] = m; });

  // team_match_gamesのstatusをmatch.statusと同期させる。
  // ただし毎回無条件に更新せず、変更が必要な番手だけ更新する。
  const syncTargets = games.filter(g => {
    if (!g.match_id) return false;
    const m = matchMap[g.match_id];
    return m?.status === "finished" && g.status !== "finished";
  });
  await Promise.all(syncTargets.map(g =>
    supabase.from("team_match_games")
      .update({ status:"finished", recorder_id:null, recorder_name:null })
      .eq("id", g.id)
  ));
  syncTargets.forEach(g => { g.status = "finished"; });

  let myScore = 0, oppScore = 0;
  for (const g of games) {
    if (!g.match_id) continue;
    const m = matchMap[g.match_id];
    if (!m || m.status !== "finished") continue;
    if (m.match_score_a > m.match_score_b) myScore++;
    else if (m.match_score_b > m.match_score_a) oppScore++;
  }

  const winTarget = tm.format === "best2" ? 2 : 3;
  const totalGames = 3;
  const winDecided = myScore >= winTarget || oppScore >= winTarget;

  const registeredGames = games.filter(g => g.match_id);
  const allRegisteredDone = registeredGames.length > 0 && registeredGames.every(g => {
    const m = matchMap[g.match_id];
    return m?.status === "finished" || m?.status === "abandoned" || g.status === "suspended";
  });
  const allSlotsFilled = games.length >= totalGames;
  const allDone = allSlotsFilled && allRegisteredDone;

  const newStatus = winDecided || allDone ? "finished" : "active";
  const changed = tm.my_score !== myScore || tm.opponent_score !== oppScore || tm.status !== newStatus;

  if (changed) {
    const { error: updateErr } = await supabase.from("team_matches").update({
      my_score: myScore,
      opponent_score: oppScore,
      status: newStatus,
    }).eq("id", teamMatchId);
    if (updateErr) { console.error(updateErr); return null; }
  }

  return { my_score: myScore, opponent_score: oppScore, status: newStatus, changed };
}

// ============================================================
// 大会マスター
// ============================================================
async function getTournaments() {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .is("deleted_at", null)
    .order("start_date", { ascending: false });
  if (error) { console.error(error); return []; }
  return data ?? [];
}

// ★ゴミ箱：削除済み（deleted_atが入っている）大会一覧を取得
async function getDeletedTournaments() {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data ?? [];
}

async function saveTournament(t) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const row = {
    id: t.id || uid(),
    created_by: t.created_by || user.id,
    name: (t.name || "").trim(),
    start_date: t.start_date,
    end_date: t.end_date || t.start_date,
    venue: t.venue || null,
  };
  const { error } = await supabase.from("tournaments").upsert(row);
  if (error) throw error;
  return row;
}

// ★大会名を変更した時、既に作成済みの個人戦・団体戦の tournament_name（文字列で紐付けている）が
//   追従せず残ってしまい、見た目は同じでも文字として一致しなくなり大会と切り離されてしまう不具合があった。
//   大会名編集時は必ずこれを呼び、旧名称の試合を新名称に一括で書き換える。
async function renameTournamentCascade(oldName, newName) {
  const oldTrimmed = (oldName || "").trim();
  const newTrimmed = (newName || "").trim();
  if (!oldTrimmed || !newTrimmed || oldTrimmed === newTrimmed) return;
  const [r1, r2] = await Promise.all([
    supabase.from("matches").update({ tournament_name: newTrimmed }).eq("tournament_name", oldTrimmed),
    supabase.from("team_matches").update({ tournament_name: newTrimmed }).eq("tournament_name", oldTrimmed),
  ]);
  if (r1.error) console.error("個人戦の大会名追従に失敗:", r1.error);
  if (r2.error) console.error("団体戦の大会名追従に失敗:", r2.error);
}

// ★大会の削除は誤操作対策のため即時完全削除ではなくゴミ箱行き（論理削除）にする
async function deleteTournament(id) {
  const { error } = await supabase.from("tournaments").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

// ゴミ箱から元に戻す
async function restoreTournament(id) {
  const { error } = await supabase.from("tournaments").update({ deleted_at: null }).eq("id", id);
  if (error) throw error;
}

// ゴミ箱から完全に削除する（元に戻せません）
async function permanentlyDeleteTournament(id) {
  const { error } = await supabase.from("tournaments").delete().eq("id", id);
  if (error) throw error;
}

// ★ゴミ箱は24時間で自動的に空にする。バックグラウンド処理は無いため、
// トップ画面の読み込みやゴミ箱を開いたタイミングで、期限切れのものを完全削除する。
async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    await Promise.all([
      supabase.from("tournaments").delete().not("deleted_at", "is", null).lt("deleted_at", cutoff),
      supabase.from("matches").delete().not("deleted_at", "is", null).lt("deleted_at", cutoff),
      supabase.from("team_matches").delete().not("deleted_at", "is", null).lt("deleted_at", cutoff),
    ]);
  } catch (e) {
    console.error("ゴミ箱の自動削除に失敗:", e);
  }
}

// ============================================================
// ドロー機能（draw_matches / draw_entries）
// ============================================================

// 指定した大会・種別・ブロックの draw_matches を全件取得（回戦→並び順）
async function getDrawMatches(tournamentId, category, blockLabel) {
  let q = supabase.from("draw_matches").select("*").eq("tournament_id", tournamentId).eq("category", category);
  q = blockLabel ? q.eq("block_label", blockLabel) : q.is("block_label", null);
  const { data, error } = await q.order("round_no", { ascending: true }).order("slot_no", { ascending: true });
  if (error) { console.error(error); return []; }
  return data ?? [];
}

// その大会・種別で使われているブロックラベル一覧（ブロック分けの有無を判定するため）
async function getDrawBlockLabels(tournamentId, category) {
  const { data, error } = await supabase
    .from("draw_matches")
    .select("block_label")
    .eq("tournament_id", tournamentId)
    .eq("category", category);
  if (error) { console.error(error); return []; }
  const set = new Set((data ?? []).map(r => r.block_label).filter(Boolean));
  return Array.from(set).sort();
}

// 大会・種別に紐づくドローの合計試合数（大会詳細画面で「ドローが設定済み」を示すため）
async function getDrawSummary(tournamentId, category) {
  const { count, error } = await supabase
    .from("draw_matches")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId)
    .eq("category", category);
  if (error) { console.error(error); return 0; }
  return count ?? 0;
}

// 回戦ごとの試合数（desiredCounts配列。index0=1回戦）を元に draw_matches を差分更新する。
// ・増える分 → 空枠(未定)を追加するだけ
// ・減る分   → 対戦情報が入っていない枠から削除。足りない場合はそのラウンドをスキップし、
//              呼び出し元に「skippedRounds」として伝える（対戦情報が入っている枠を消すには
//              別途「削除する試合を選ぶ」操作が必要なため、ここでは自動で消さない）
async function saveDrawRounds(tournamentId, category, blockLabel, desiredCounts) {
  const existing = await getDrawMatches(tournamentId, category, blockLabel);
  const byRound = {};
  existing.forEach(row => {
    if (!byRound[row.round_no]) byRound[row.round_no] = [];
    byRound[row.round_no].push(row);
  });

  const toInsert = [];
  const toDeleteIds = [];
  const skippedRounds = [];

  // 既存データにあるラウンド番号と、これから欲しいラウンド番号(1..desiredCounts.length)の両方を対象にする。
  // これにより「回戦数を減らした」ことで生まれる末尾ラウンド（desiredCountsの範囲外）も
  // ちゃんと削除対象として扱われる（desired=0として処理）。
  const allRoundNos = new Set(Object.keys(byRound).map(Number));
  for (let i = 0; i < desiredCounts.length; i++) allRoundNos.add(i + 1);

  Array.from(allRoundNos).sort((a, b) => a - b).forEach(roundNo => {
    const desired = roundNo <= desiredCounts.length ? desiredCounts[roundNo - 1] : 0;
    const rows = (byRound[roundNo] || []).slice().sort((a, b) => a.slot_no - b.slot_no);
    const current = rows.length;

    if (desired > current) {
      let nextSlot = rows.length ? Math.max(...rows.map(r => r.slot_no)) + 1 : 1;
      for (let k = 0; k < desired - current; k++) {
        toInsert.push({
          id: uid(),
          tournament_id: tournamentId,
          category,
          block_label: blockLabel || null,
          round_no: roundNo,
          slot_no: nextSlot++,
        });
      }
    } else if (desired < current) {
      const emptyRows = rows.filter(r => !r.side_a_entry_id && !r.side_b_entry_id);
      const needToRemove = current - desired;
      if (emptyRows.length >= needToRemove) {
        emptyRows.sort((a, b) => b.slot_no - a.slot_no).slice(0, needToRemove).forEach(r => toDeleteIds.push(r.id));
      } else {
        skippedRounds.push({ round: roundNo, desired, current, emptyAvailable: emptyRows.length });
      }
    }
  });

  if (toInsert.length) {
    const { error } = await supabase.from("draw_matches").insert(toInsert);
    if (error) throw error;
  }
  if (toDeleteIds.length) {
    const { error } = await supabase.from("draw_matches").delete().in("id", toDeleteIds);
    if (error) throw error;
  }
  return { skippedRounds };
}

// ブロック分けを確定したときに、旧「すべて（ブロックなし）」のドローが残っていれば片付ける。
// 対戦情報が入っていない枠のみ安全に削除し、入っている枠が残っていれば削除せずに件数を返す
// （呼び出し元はその件数をユーザーに伝え、勝手にはデータを消さない）。
async function clearUnblockedDraw(tournamentId, category) {
  const rows = await getDrawMatches(tournamentId, category, null);
  if (rows.length === 0) return { cleared: true, remaining: 0 };
  const emptyRows = rows.filter(r => !r.side_a_entry_id && !r.side_b_entry_id);
  const remaining = rows.length - emptyRows.length;
  if (emptyRows.length) {
    const { error } = await supabase.from("draw_matches").delete().in("id", emptyRows.map(r => r.id));
    if (error) throw error;
  }
  return { cleared: remaining === 0, remaining };
}

// 既存のブロック分け（A/B/C/D…）をすべて片付けて、「すべて」から改めてブロック分けをやり直せるようにする。
// 対戦情報が入っていない枠のみ安全に削除し、入っている枠が残っていれば削除せずに件数を返す。
async function clearAllBlocksDraw(tournamentId, category) {
  const labels = await getDrawBlockLabels(tournamentId, category);
  let remaining = 0;
  for (const label of labels) {
    const rows = await getDrawMatches(tournamentId, category, label);
    const emptyRows = rows.filter(r => !r.side_a_entry_id && !r.side_b_entry_id);
    remaining += rows.length - emptyRows.length;
    if (emptyRows.length) {
      const { error } = await supabase.from("draw_matches").delete().in("id", emptyRows.map(r => r.id));
      if (error) throw error;
    }
  }
  return { cleared: remaining === 0, remaining };
}

// draw_matches に、それぞれの側（サイドA/B）のエントリー情報（学校名・選手名）を付けて取得する
// （大会詳細のトーナメント表表示用）
async function getDrawMatchesWithEntries(tournamentId, category, blockLabel) {
  const matches = await getDrawMatches(tournamentId, category, blockLabel);
  if (matches.length === 0) return [];
  const entryIds = Array.from(new Set(matches.flatMap(m => [m.side_a_entry_id, m.side_b_entry_id]).filter(Boolean)));
  let entryMap = {};
  if (entryIds.length) {
    const { data, error } = await supabase.from("draw_entries").select("*").in("id", entryIds);
    if (error) console.error(error);
    (data ?? []).forEach(e => { entryMap[e.id] = e; });
  }
  // ドロー画面のカードにスコア・進行状況を表示するため、紐づく試合の最小限の情報も取得する
  const matchIds = Array.from(new Set(matches.map(m => m.match_id).filter(Boolean)));
  let matchInfoMap = {};
  if (matchIds.length) {
    const { data, error } = await supabase.from("matches").select("id, status, match_score_a, match_score_b, memo").in("id", matchIds);
    if (error) console.error(error);
    (data ?? []).forEach(mi => { matchInfoMap[mi.id] = mi; });
  }
  return matches.map(m => ({
    ...m,
    sideA: m.side_a_entry_id ? entryMap[m.side_a_entry_id] : null,
    sideB: m.side_b_entry_id ? entryMap[m.side_b_entry_id] : null,
    matchInfo: m.match_id ? (matchInfoMap[m.match_id] || null) : null,
  }));
}

// draw_entries の作成・更新（対戦情報入力シートから呼ばれる）
async function saveDrawEntry(entry) {
  const row = {
    id: entry.id,
    tournament_id: entry.tournament_id,
    category: entry.category,
    block_label: entry.block_label || null,
    entry_no: entry.entry_no || null,
    is_own_team: !!entry.is_own_team,
    school_name: entry.school_name || null,
    school_name_secondary: entry.school_name_secondary || null,
    player1_name: entry.player1_name || null,
    player2_name: entry.player2_name || null,
    is_withdrawn: !!entry.is_withdrawn,
  };
  const { error } = await supabase.from("draw_entries").upsert(row);
  if (error) throw error;
  return row;
}

// この試合(matches.id)がドローの枠から作られたものかどうかを逆引きする。
// 「✏️ 編集」画面でエントリー番号をあわせて編集できるようにするために使う。
async function getDrawMatchByMatchId(matchId) {
  const { data, error } = await supabase.from("draw_matches").select("id, side_a_entry_id, side_b_entry_id").eq("match_id", matchId).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

// エントリー番号だけをピンポイントで更新する（他の項目は変更しない）
async function updateDrawEntryNo(entryId, entryNo) {
  if (!entryId) return;
  const { error } = await supabase.from("draw_entries").update({ entry_no: entryNo || null }).eq("id", entryId);
  if (error) throw error;
}

// draw_matches の指定サイドに、作成済みのエントリーを紐づける
// ★複数人が同時に同じ枠へ入力しても上書きしないための安全版。
//   対象の列（side_a_entry_id / side_b_entry_id）がまだ空のときだけ更新する。
//   既に別の人が埋めていた場合は上書きせず、現在入っている値を返す。
async function setDrawMatchSideSafe(drawMatchId, side, entryId) {
  const col = side === "A" ? "side_a_entry_id" : "side_b_entry_id";
  const { data, error } = await supabase
    .from("draw_matches")
    .update({ [col]: entryId, updated_at: new Date().toISOString() })
    .eq("id", drawMatchId)
    .is(col, null)
    .select(`id, ${col}`);
  if (error) throw error;
  if (data && data.length > 0) return { ok: true };
  const { data: current, error: fetchErr } = await supabase.from("draw_matches").select(col).eq("id", drawMatchId).single();
  if (fetchErr) throw fetchErr;
  return { ok: false, currentEntryId: current[col] };
}

// 試合を削除したときに、紐づいているドロー枠のmatch_idもクリアして
// 枠を再び「予定」（対戦情報を編集・試合作成可能）の状態に戻す
async function clearDrawMatchLink(drawMatchId) {
  const { error } = await supabase.from("draw_matches").update({ match_id: null, updated_at: new Date().toISOString() }).eq("id", drawMatchId);
  if (error) throw error;
}


// 団体戦の「結果だけ記録」機能：個々の試合（1複・2複…）を作らず、
// 勝ったチーム（A/B）とスコアだけをdraw_matchesに保存する。
async function saveSimpleTeamResult(drawMatchId, winnerSide, scoreA, scoreB) {
  const { error } = await supabase.from("draw_matches").update({
    simple_result_winner: winnerSide,
    simple_result_score_a: scoreA,
    simple_result_score_b: scoreB,
    updated_at: new Date().toISOString(),
  }).eq("id", drawMatchId);
  if (error) throw error;
}
async function clearSimpleTeamResult(drawMatchId) {
  const { error } = await supabase.from("draw_matches").update({
    simple_result_winner: null,
    simple_result_score_a: null,
    simple_result_score_b: null,
    updated_at: new Date().toISOString(),
  }).eq("id", drawMatchId);
  if (error) throw error;
}

async function getDrawMatchRaw(id) {
  const { data, error } = await supabase.from("draw_matches").select("id, side_a_entry_id, side_b_entry_id").eq("id", id).single();
  if (error) throw error;
  return data;
}

// 同じ大会・同じブロック内で、指定したentry_noが既に別のエントリーで使われていないか確認する
// （excludeEntryIdsに含まれるエントリー自身との重複は無視する＝自分自身の更新はOK）
async function checkDuplicateEntryNo(tournamentId, category, blockLabel, entryNo, excludeEntryIds) {
  if (!entryNo) return false;
  let query = supabase.from("draw_entries").select("id").eq("tournament_id", tournamentId).eq("category", category).eq("entry_no", entryNo);
  query = blockLabel ? query.eq("block_label", blockLabel) : query.is("block_label", null);
  const { data, error } = await query;
  if (error) { console.error(error); return false; }
  return (data || []).some(row => !(excludeEntryIds || []).includes(row.id));
}

// ドローの枠（両サイドとも埋まっている状態）から、実際にスコアを付けられる試合(matches)を作成し、
// draw_matches.match_id に紐づける。作成後は通常の試合一覧にも表示されるようになる。
//
// ★二重作成防止：連打・通信遅延・複数端末からの同時操作で同じ枠から
//   複数のmatchesが作られないよう、以下の手順を踏む。
//   1) 呼び出し直後に最新のmatch_idをDBから再取得し、既にあればそれを返す
//   2) 新規作成後の更新は match_id が null のときだけ（.is("match_id", null)）
//   3) 更新が0件（＝他で先に作成済み）だった場合は、今回作った孤立試合を削除して
//      既存の方のmatch_idを返す
//   4) 更新自体がエラーだった場合も、孤立試合を削除してからエラーを投げる
async function createMatchFromDrawSlot(drawMatch, tournamentName, roundLabel) {
  // 1) 最新状態を確認（画面上の情報が古い可能性があるため）
  const { data: latest, error: fetchErr } = await supabase
    .from("draw_matches")
    .select("id, match_id")
    .eq("id", drawMatch.id)
    .single();
  if (fetchErr) throw fetchErr;
  if (latest?.match_id) return latest.match_id; // 既に作成済みならそれを使い回す

  const matchId = uid();
  const players = [];
  const addSide = (entry, team) => {
    if (!entry) return;
    if (entry.player1_name) players.push({ id: uid(), team, player_name: entry.player1_name, club_name: entry.school_name || "", position: "", order_num: 1 });
    if (entry.player2_name) players.push({ id: uid(), team, player_name: entry.player2_name, club_name: entry.school_name || "", position: "", order_num: 2 });
  };
  // ★自チームは必ずチームA、相手を必ずチームBにする（ドロー上の上側/下側の並び順とは無関係）。
  //   アプリ全体の色分け（緑=自チーム/オレンジ=相手）や統計はチームA=自チーム前提のため、
  //   ドロー入力時にどちらを上側/下側に入れたかで色分けが崩れないようにする。
  const ownIsB = drawMatch.sideB?.is_own_team && !drawMatch.sideA?.is_own_team;
  if (ownIsB) {
    addSide(drawMatch.sideB, "A");
    addSide(drawMatch.sideA, "B");
  } else {
    addSide(drawMatch.sideA, "A");
    addSide(drawMatch.sideB, "B");
  }

  const match = {
    id: matchId,
    match_date: new Date().toISOString().slice(0, 10),
    venue: "",
    tournament_name: tournamentName,
    round: roundLabel,
    match_type: "tournament",
    game_format: 7,
    is_doubles: true,
    first_server: null,
    status: "scheduled",
    match_score_a: 0,
    match_score_b: 0,
    memo: "",
    court_number: "",
    is_younger: true,
    players,
  };
  await saveMatch(match);

  // 2) match_id が null のときだけ更新する（他の端末が先に作成していたら0件になる）
  //    ★あわせて「結果だけ記録」の内容が残っていたら消す（実際の試合＝正としてスコアを付け直すため）
  const { data: updatedRows, error: updateErr } = await supabase
    .from("draw_matches")
    .update({
      match_id: matchId, updated_at: new Date().toISOString(),
      simple_result_winner: null, simple_result_score_a: null, simple_result_score_b: null,
    })
    .eq("id", drawMatch.id)
    .is("match_id", null)
    .select("id, match_id");

  if (updateErr) {
    // 更新に失敗した場合、作成済みの試合が孤立してしまうため削除しておく
    await deleteMatch(matchId).catch(() => {});
    throw updateErr;
  }

  if (!updatedRows || updatedRows.length === 0) {
    // 3) 競合発生：既に別の操作でmatch_idがセットされていた
    //    今回作った孤立試合を削除し、既存の方のmatch_idを返す
    await deleteMatch(matchId).catch(() => {});
    const { data: current, error: recheckErr } = await supabase
      .from("draw_matches")
      .select("match_id")
      .eq("id", drawMatch.id)
      .single();
    if (recheckErr) throw recheckErr;
    return current?.match_id ?? null;
  }

  return matchId;
}

// 棄権による不戦勝処理：片方のサイドが棄権になったタイミングで、
// 実際のスコア入力を待たずに「終了扱い（不戦勝）」の試合を作成し、draw_matches.match_id に紐づける。
// winnerSide: 勝ち上がる側（棄権していない側）"A" | "B"
// 二重作成防止の考え方は createMatchFromDrawSlot と同様（先に最新状態を確認し、更新は match_id が null のときだけ行う）
async function createWalkoverMatch(drawMatch, tournamentName, roundLabel, winnerSide) {
  const { data: latest, error: fetchErr } = await supabase
    .from("draw_matches")
    .select("id, match_id")
    .eq("id", drawMatch.id)
    .single();
  if (fetchErr) throw fetchErr;
  if (latest?.match_id) return latest.match_id; // 既に試合が作成済みならそれを使い回す

  const matchId = uid();
  const players = [];
  const addSide = (entry, team) => {
    if (!entry) return;
    if (entry.player1_name) players.push({ id: uid(), team, player_name: entry.player1_name, club_name: entry.school_name || "", position: "", order_num: 1 });
    if (entry.player2_name) players.push({ id: uid(), team, player_name: entry.player2_name, club_name: entry.school_name || "", position: "", order_num: 2 });
  };
  // ★通常の試合作成と同様、自チームは必ずチームAになるようにする
  const ownIsB = drawMatch.sideB?.is_own_team && !drawMatch.sideA?.is_own_team;
  const effectiveWinnerSide = ownIsB ? (winnerSide === "A" ? "B" : "A") : winnerSide;
  if (ownIsB) {
    addSide(drawMatch.sideB, "A");
    addSide(drawMatch.sideA, "B");
  } else {
    addSide(drawMatch.sideA, "A");
    addSide(drawMatch.sideB, "B");
  }

  const gameFormat = 7;
  const winGames = calcWinGames(gameFormat);
  const match = {
    id: matchId,
    match_date: new Date().toISOString().slice(0, 10),
    venue: "",
    tournament_name: tournamentName,
    round: roundLabel,
    match_type: "tournament",
    game_format: gameFormat,
    is_doubles: true,
    first_server: null,
    status: "finished",
    match_score_a: effectiveWinnerSide === "A" ? winGames : 0,
    match_score_b: effectiveWinnerSide === "B" ? winGames : 0,
    memo: "不戦勝（相手棄権）",
    court_number: "",
    is_younger: true,
    players,
  };
  await saveMatch(match);

  const { data: updatedRows, error: updateErr } = await supabase
    .from("draw_matches")
    .update({ match_id: matchId, updated_at: new Date().toISOString() })
    .eq("id", drawMatch.id)
    .is("match_id", null)
    .select("id, match_id");

  if (updateErr) {
    await deleteMatch(matchId).catch(() => {});
    throw updateErr;
  }
  if (!updatedRows || updatedRows.length === 0) {
    await deleteMatch(matchId).catch(() => {});
    const { data: current, error: recheckErr } = await supabase
      .from("draw_matches")
      .select("match_id")
      .eq("id", drawMatch.id)
      .single();
    if (recheckErr) throw recheckErr;
    return current?.match_id ?? null;
  }
  return matchId;
}
const calcWinGames = (fmt) => Math.ceil(fmt / 2);
const isFinalGame  = (fmt, sA, sB) => { const w = calcWinGames(fmt); return sA === w-1 && sB === w-1; };
const gameServer   = (first, num)  => num % 2 === 1 ? first : (first === "A" ? "B" : "A");

function checkNormalWinner(a, b) {
  if (a >= 4 && a - b >= 2) return "A";
  if (b >= 4 && b - a >= 2) return "B";
  return null;
}
function checkFinalWinner(a, b) {
  if (a >= 7 && a - b >= 2) return "A";
  if (b >= 7 && b - a >= 2) return "B";
  return null;
}
function finalServer(first, played) {
  return Math.floor(played / 2) % 2 === 0 ? first : (first === "A" ? "B" : "A");
}

// ============================================================
// 統計計算（play_type / result_type ベースに対応）
// ============================================================
function calcPlayerStats(match) {
  if (!match) return [];
  const matchPlayers = Array.isArray(match.players) ? match.players : [];
  const matchGames = Array.isArray(match.games) ? match.games : [];

  // 選手名 -> 所属チーム('A'/'B') の対応表（match_playersが正、scoring_teamには依存しない）
  const teamOf = {};
  for (const p of matchPlayers) { if (p?.player_name) teamOf[p.player_name] = p.team; }

  const result = {};
  const ensure = (playerTeam, playerName) => {
    const key = playerTeam + "__" + playerName;
    if (!result[key]) {
      result[key] = {
        team: playerTeam, player_name: playerName, total: 0, winners: 0, errors: 0, plays: {}, results: {},
        playsWin: {}, playsErr: {}, // ★決めたプレイ／ミスしたプレイの内訳用
        // ★1stサーブ確率・レシーブミス率用
        serveTotal: 0, serveFault: 0, receiveTotal: 0, receiveMiss: 0,
      };
    }
    return result[key];
  };

  // チームごとの選手をorder_num順に並べる（[0]=選手1, [1]=選手2）
  const teamPlayers = {
    A: matchPlayers.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name),
    B: matchPlayers.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name),
  };
  // ソフトテニスのダブルス規則：1ゲーム内、サーブ側ペアは2ポイントずつ交代でサーブする
  // （選手1が1-2点目、選手2が3-4点目...）。レシーブ側も同じ交代タイミングに対応する選手が受ける。
  // シングルスの場合はteamPlayersが1人なので常にその選手に集計される。
  const individualAt = (players, turn) => {
    if (!Array.isArray(players) || players.length===0) return null;
    if (players.length===1) return players[0];
    return Math.floor(turn/2)%2===0 ? players[0] : players[1];
  };

  for (const g of matchGames) {
    const points = Array.isArray(g.points) ? g.points : [];
    const faults = Array.isArray(g.faults) ? g.faults : [];
    for (const pt of points) {
      if (!pt.player_name) continue;
      // ★重要：「得点(勝ち)」はscoring_teamの選手の得点だが、「ミス」はscoring_teamの
      // 　"相手"側の選手の失点であり、scoring_teamそのものとイコールではない。
      // 　（例：相手のレシーブミスで自チームが得点した場合、scoring_team="A"だが
      // 　　player_nameは相手チームの選手であり、そのミスは相手チームの記録になる）
      // 　そのためis_winnerとscoring_teamから選手の所属チームを正しく推定し、
      // 　同名選手が両チームに存在する場合の取り違えを防ぐ。teamOfは推定できない時の保険。
      const inferredTeam = pt.scoring_team==="A" ? (pt.is_winner ? "A" : "B")
                         : pt.scoring_team==="B" ? (pt.is_winner ? "B" : "A")
                         : null;
      const playerTeam = inferredTeam ?? teamOf[pt.player_name];
      const r = ensure(playerTeam, pt.player_name);
      r.total++;
      if (pt.is_winner) r.winners++; else r.errors++;
      if (pt.play_type)   r.plays[pt.play_type]     = (r.plays[pt.play_type]   ?? 0) + 1;
      if (pt.result_type) r.results[pt.result_type] = (r.results[pt.result_type] ?? 0) + 1;
      if (pt.play_type) {
        const bucket = pt.is_winner ? r.playsWin : r.playsErr;
        bucket[pt.play_type] = (bucket[pt.play_type] ?? 0) + 1;
      }
    }
    for (const f of faults) {
      if (!f.player_name) continue;
      const playerTeam = f.server_team ?? teamOf[f.player_name];
      const r = ensure(playerTeam, f.player_name);
      r.plays["fault"] = (r.plays["fault"] ?? 0) + 1;
    }

    // ★1stサーブ確率・レシーブミス率（2ポイントごとの選手交代を反映して個人に按分）
    let beforeA = 0, beforeB = 0;       // このポイント開始時点のスコア（フォルト記録との突き合わせ用）
    let serveTurnA = 0, serveTurnB = 0; // 各チームがこのゲームで通算何ポイント目のサーブか
    for (let idx=0; idx<points.length; idx++) {
      const pt = points[idx];
      const serverTeam  = g.is_final ? finalServer(g.server_team, idx) : g.server_team;
      if (serverTeam !== "A" && serverTeam !== "B") { beforeA = pt.score_a_after; beforeB = pt.score_b_after; continue; }
      const receiveTeam = serverTeam==="A" ? "B" : "A";
      const serveTurn   = serverTeam==="A" ? serveTurnA : serveTurnB;

      const serverPlayer   = individualAt(teamPlayers[serverTeam],  serveTurn);
      const receiverPlayer = individualAt(teamPlayers[receiveTeam], serveTurn);

      // ★このポイントの直前に1stフォルトがあったかは、ポイント自身が持つfault_countで確実に判定できる
      // 　（別テーブルのfaultsとスコアで突き合わせる方式は、フォルト記録時のスコアが実際とズレていると
      // 　　対応が取れなくなり、集計から漏れることがあったため廃止）
      const hadFault = (pt.fault_count ?? 0) >= 1;

      if (serverPlayer) {
        const r = ensure(serverTeam, serverPlayer);
        r.serveTotal++;
        if (hadFault) r.serveFault++;
      }
      if (receiverPlayer) {
        const r = ensure(receiveTeam, receiverPlayer);
        r.receiveTotal++;
        if (pt.play_type==="receive" && pt.result_type==="error" && pt.player_name===receiverPlayer) r.receiveMiss++;
      }

      if (serverTeam==="A") serveTurnA++; else serveTurnB++;
      beforeA = pt.score_a_after; beforeB = pt.score_b_after;
    }
  }
  return Object.values(result);
}

function calcAutoComment(stats, team) {
  const comments = [];
  for (const p of stats.filter(s => s.team === team)) {
    const topPlay   = Object.entries(p.plays).filter(([k])=>k!=="fault").sort((a,b)=>b[1]-a[1])[0];
    const topResult = Object.entries(p.results).sort((a,b)=>b[1]-a[1])[0];
    if (topPlay && p.winners > 0) {
      const pct = Math.round((p.plays[topPlay[0]] ?? 0) / p.total * 100);
      comments.push({ type: "strength", player: p.player_name, text: `${getPlayLabel(topPlay[0])}が全ポイントの${pct}%を占める主な得点パターン。` });
    }
    if (p.errors > 0 && topResult && !isWinnerResult(topResult[0])) {
      const pct = Math.round(topResult[1] / (p.errors || 1) * 100);
      comments.push({ type: "weakness", player: p.player_name, text: `${getResultLabel(topResult[0])}による失点が${pct}%。重点的に改善が必要。` });
    }
    const df = p.plays["fault"] ?? 0;
    if (df >= 2) comments.push({ type: "warning", player: p.player_name, text: `1stフォルト${df}回。サーブの安定が課題。` });
  }
  return comments;
}

// ============================================================
// ★試合サマリー／AI総評／改善優先順位（自チーム=A視点で集計）
// ============================================================
function calcMatchSummary(match) {
  const allPts = match.games.flatMap(g => g.points);
  const totalA = allPts.filter(p=>p.scoring_team==="A").length;
  const totalB = allPts.filter(p=>p.scoring_team==="B").length;
  const winA   = allPts.filter(p=>p.scoring_team==="A"&&p.is_winner===true).length;
  const winB   = allPts.filter(p=>p.scoring_team==="B"&&p.is_winner===true).length;
  const attackA = winA, oppMissA = totalA-winA, selfMissA = totalB-winB, oppAttackA = winB;
  const decisionRate = (attackA+selfMissA)>0 ? Math.round(attackA/(attackA+selfMissA)*100) : null;

  const stats = calcPlayerStats(match);
  const teamAStats = stats.filter(s=>s.team==="A");
  const scoreRanking = teamAStats.slice().sort((a,b)=>b.winners-a.winners);
  const missRanking  = teamAStats.slice().sort((a,b)=>b.errors-a.errors);
  const topScorer = scoreRanking[0] ?? null;

  // 前衛／後衛（登録順=order_num 0番目を後衛、1番目を前衛として扱う）
  const aPlayersSorted = match.players.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num);
  const posStats = {
    front: { label:"前衛", name: aPlayersSorted[1]?.player_name ?? null, win:0, err:0 },
    back:  { label:"後衛", name: aPlayersSorted[0]?.player_name ?? null, win:0, err:0 },
  };
  aPlayersSorted.forEach((p,idx)=>{
    const key = idx===0 ? "back" : "front";
    const s = teamAStats.find(x=>x.player_name===p.player_name);
    if (s && posStats[key]) { posStats[key].win += s.winners; posStats[key].err += s.errors; }
  });

  // プレイ別成功率（チーム全体で合算。fault除く。サンプル2回未満は信頼性が低いため除外）
  const playAgg = {};
  teamAStats.forEach(s=>{
    Object.entries(s.playsWin).forEach(([k,n])=>{ playAgg[k]=playAgg[k]||{win:0,err:0}; playAgg[k].win+=n; });
    Object.entries(s.playsErr).forEach(([k,n])=>{ if(k==="fault") return; playAgg[k]=playAgg[k]||{win:0,err:0}; playAgg[k].err+=n; });
  });
  const playRates = Object.entries(playAgg)
    .map(([k,v])=>({ key:k, label:getPlayLabel(k), total:v.win+v.err, win:v.win, err:v.err, rate:(v.win+v.err)>0?Math.round(v.win/(v.win+v.err)*100):0 }))
    .filter(p=>p.total>=2);
  const bestPlays  = playRates.slice().sort((a,b)=>b.rate-a.rate).slice(0,3);
  const worstPlays = playRates.slice().sort((a,b)=>a.rate-b.rate).slice(0,3);

  // サーブ分析（自チームのサーブのみ。fault_count: 0=1stイン/1=2ndイン/2=ダブルフォルト）
  let serve1st=0, serve2nd=0, serveDf=0, serveTotal=0;
  let firstServeWin=0, firstServeTotal=0, secondServeWin=0, secondServeTotal=0;
  for (const g of match.games) {
    for (let idx=0; idx<g.points.length; idx++) {
      const pt = g.points[idx];
      const serverTeam = g.is_final ? finalServer(g.server_team, idx) : g.server_team;
      if (serverTeam!=="A") continue;
      serveTotal++;
      if (pt.fault_count===0){ serve1st++; firstServeTotal++; if(pt.scoring_team==="A") firstServeWin++; }
      else if (pt.fault_count===1){ serve2nd++; secondServeTotal++; if(pt.scoring_team==="A") secondServeWin++; }
      else if (pt.fault_count===2){ serveDf++; }
    }
  }

  // 試合の流れ：最大連続得点／連続失点
  let curStreak=0, curTeam=null, maxWinStreak=0, maxLoseStreak=0;
  allPts.forEach(p=>{
    if (p.scoring_team===curTeam) curStreak++; else { curTeam=p.scoring_team; curStreak=1; }
    if (curTeam==="A") maxWinStreak=Math.max(maxWinStreak,curStreak);
    else maxLoseStreak=Math.max(maxLoseStreak,curStreak);
  });

  // 得点推移（1ゲーム目）
  const firstGame = match.games[0];
  const timeline = firstGame ? firstGame.points.map(p=>({
    team:p.scoring_team, isWinner:p.is_winner, player:p.player_name, play:p.play_type,
  })) : [];

  return {
    totalA, totalB, attackA, oppMissA, selfMissA, oppAttackA, decisionRate,
    topScorer, scoreRanking, missRanking, posStats, bestPlays, worstPlays,
    serve1st, serve2nd, serveDf, serveTotal, firstServeWin, firstServeTotal, secondServeWin, secondServeTotal,
    maxWinStreak, maxLoseStreak, timeline,
  };
}

function buildAiSummary(sum) {
  const lines = [];
  if (sum.totalA>0) {
    const pct = Math.round(sum.attackA/sum.totalA*100);
    lines.push(`攻撃による得点が${pct}%と${pct>=50?"高く、自分たちの形で試合を進められています":"、相手のミスに助けられている場面も見られます"}。`);
  }
  if (sum.totalB>0) {
    const pct = Math.round(sum.oppAttackA/sum.totalB*100);
    lines.push(`失点の${pct}%は相手の攻撃によるものでした。`);
  }
  if (sum.worstPlays[0]) lines.push(`${sum.worstPlays[0].label}の成功率が${sum.worstPlays[0].rate}%と低く、ここが課題です。`);
  if (sum.bestPlays[0])  lines.push(`${sum.bestPlays[0].label}は成功率${sum.bestPlays[0].rate}%で最大の得点源です。`);
  if (sum.secondServeTotal>0) {
    const rate = Math.round(sum.secondServeWin/sum.secondServeTotal*100);
    lines.push(`2ndサーブ時の得点率は${rate}%でした。`);
  }
  const todayPoints = [];
  if (sum.worstPlays[0]) todayPoints.push(`${sum.worstPlays[0].label}の成功率向上`);
  if (sum.bestPlays[0])  todayPoints.push(`${sum.bestPlays[0].label}は継続`);
  if (sum.secondServeTotal>0 && Math.round(sum.secondServeWin/sum.secondServeTotal*100) < 50) {
    todayPoints.push("2ndサーブ時の組み立てを見直す");
  }
  return { text: lines.join(""), todayPoints };
}

function buildHighlights(sum) {
  const good = [];
  const bad = [];
  if (sum.bestPlays[0])  good.push(`${sum.bestPlays[0].label}の成功率が${sum.bestPlays[0].rate}%で、この試合最大の得点源でした。`);
  if (sum.worstPlays[0]) bad.push(`${sum.worstPlays[0].label}の成功率が${sum.worstPlays[0].rate}%と低く、次の課題です。`);

  if (sum.totalA>0 && good.length<2) {
    const pct = Math.round(sum.attackA/sum.totalA*100);
    if (pct>=50) good.push(`攻撃で決めた得点の割合が${pct}%と高く、自分たちの形で試合を進められました。`);
  }
  if (sum.secondServeTotal>0) {
    const rate = Math.round(sum.secondServeWin/sum.secondServeTotal*100);
    if (rate>=50 && good.length<2) good.push(`2ndサーブ時の得点率が${rate}%と安定していました。`);
    else if (rate<50 && bad.length<2) bad.push(`2ndサーブ時の得点率が${rate}%と低く、組み立てを見直しましょう。`);
  }
  if (sum.totalB>0 && bad.length<2) {
    const pct = Math.round(sum.oppAttackA/sum.totalB*100);
    if (pct>=50) bad.push(`失点の${pct}%は相手の攻撃によるもので、対策が必要です。`);
  }
  return { good: good.slice(0,2), bad: bad.slice(0,2) };
}

function buildPriorities(sum) {
  return sum.worstPlays.map((p,i)=>({
    stars: Math.max(5-i, 1),
    text: `${p.label}の成功率向上`,
    reason: `理由：${p.label}成功率${p.rate}%（${p.total}回中${p.win}回成功）`,
    effect: i===0 ? "期待効果：＋1〜3点" : "期待効果：＋1点前後",
  }));
}


function buildLineText(match) {
  var aP = match.players.filter(function(p){return p.team==="A";}).map(function(p){return p.player_name;}).join("/");
  var bP = match.players.filter(function(p){return p.team==="B";}).map(function(p){return p.player_name;}).join("/");
  var aC = (match.players.find(function(p){return p.team==="A";}) || {}).club_name || "";
  var bC = (match.players.find(function(p){return p.team==="B";}) || {}).club_name || "";
  var aWin = match.match_score_a > match.match_score_b;
  var t = "\u{1F3BE} \u8A66\u5408\u7D50\u679C\n";
  if (match.tournament_name) t += match.tournament_name + (match.round ? " " + match.round : "") + "\n";
  t += fmtDate(match.match_date) + (match.venue ? " @" + match.venue : "") + "\n\n";
  t += (aWin ? "\u{1F3C6} " : "") + aC + " " + aP + "\n";
  t += (!aWin && match.status==="finished" ? "\u{1F3C6} " : "") + bC + " " + bP + "\n\n";
  t += "\u30B9\u30B3\u30A2 " + match.match_score_a + " - " + match.match_score_b + "\n";
  match.games.forEach(function(g) { t += "G" + g.game_number + (g.is_final ? "(F)" : "") + ": " + g.score_a + "-" + g.score_b + "\n"; });
  return t;
}

// CSV出力
function buildCsv(match) {
  const headers = ["試合日","大会名","何回戦","ゲーム番号","ファイナルゲーム","ポイント番号","得点チーム","チーム区分","選手名","所属","プレイ内容","フォア/バック","結果","チームA得点","チームB得点"];
  const rows = [];
  for (const g of match.games) {
    for (const f of (g.faults ?? [])) {
      // ★同名選手が両チームにいる場合の取り違えを防ぐため、まずチームも一致する選手を優先して探す
      const pl = match.players.find(p=>p.player_name===f.player_name && p.team===f.server_team)
              ?? match.players.find(p=>p.player_name===f.player_name);
      rows.push([match.match_date,match.tournament_name??"",match.round??"",g.game_number,g.is_final?"YES":"NO","","",f.server_team==="A"?"自チーム":"相手チーム",f.player_name??"",pl?.club_name??""," 1stフォルト","","fault",f.score_a_at,f.score_b_at]);
    }
    for (const pt of g.points) {
      // ★得点(勝ち)なら得点チーム、ミスなら相手チームの選手なので、それに合わせてチームを絞って探す
      const ptTeam = pt.is_winner ? pt.scoring_team : (pt.scoring_team==="A" ? "B" : pt.scoring_team==="B" ? "A" : null);
      const pl = match.players.find(p=>p.player_name===pt.player_name && p.team===ptTeam)
              ?? match.players.find(p=>p.player_name===pt.player_name);
      rows.push([match.match_date,match.tournament_name??"",match.round??"",g.game_number,g.is_final?"YES":"NO",pt.point_number,pt.scoring_team,pt.scoring_team==="A"?"自チーム":"相手チーム",pt.player_name??"",pl?.club_name??"",pt.play_type?getPlayLabel(pt.play_type):"",pt.side_type?getSideLabel(pt.side_type):"",pt.result_type?getResultLabel(pt.result_type):"",pt.score_a_after,pt.score_b_after]);
    }
  }
  const esc = v => { const s = String(v == null ? "" : v); if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0) { return '"' + s.split('"').join('""'  ) + '"'; } return s; };
  return "\uFEFF"+[headers,...rows].map(r=>r.map(esc).join(",")).join("\n");
}

function downloadCsv(match) {
  const blob = new Blob([buildCsv(match)],{type:"text/csv;charset=utf-8;"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`softtennis_${match.match_date}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ============================================================
// スタイル共通
// ============================================================
const S = {
  page:   { background: C.gray, minHeight:"100vh", paddingBottom:80, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" },
  hdr:    { background:`linear-gradient(135deg,${C.navy},${C.navyMid})`, padding:"12px 16px", position:"sticky", top:0, zIndex:10 },
  card:   { background:C.white, borderRadius:12, border:`1px solid ${C.border}`, overflow:"hidden", marginBottom:10 },
  inp:    { width:"100%", padding:"8px 0", background:"transparent", border:"none", borderBottom:`1px solid ${C.border}`, fontSize:14, color:C.text, outline:"none", boxSizing:"border-box" },
  lbl:    { display:"block", fontSize:11, color:C.textSec, marginBottom:4 },
  btn:    (bg,color="white")=>({ padding:"13px 16px", background:bg, color, border:"none", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", width:"100%" }),
  togBtn: (active,ac=C.navy)=>({ padding:"8px 14px", borderRadius:8, border:`1px solid ${C.border}`, background:active?ac:C.white, color:active?C.white:C.text, fontWeight:active?700:400, fontSize:13, cursor:"pointer" }),
  chip:   (sel)=>({ display:"inline-block", padding:"5px 12px", borderRadius:20, border:`1px solid ${sel?C.navy:C.border}`, background:sel?C.navy:C.white, color:sel?C.white:C.text, fontSize:12, fontWeight:sel?700:400, cursor:"pointer", margin:"2px" }),
  row:    { padding:"10px 14px", borderBottom:`1px solid ${C.border}` },
};

// ============================================================
// 共通コンポーネント
// ============================================================
// ★モーダル表示中に背景（body）がスクロールしてしまうのを防ぐ（主にiOSで発生する不具合対策）
function useBodyScrollLock(locked) {
  useEffect(() => {
    if (!locked) return;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [locked]);
}

function Modal({ children, onClose }) {
  useBodyScrollLock(true);
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20 }}>
      <div style={{ background:C.white,borderRadius:20,padding:"28px 20px",width:"100%",maxWidth:340 }} onClick={e=>e.stopPropagation()}>{children}</div>
    </div>
  );
}

function NavBar({ active, onNavigate }) {
  const items = [
    ["home",   "🏠", "ホーム"],
    ["list",   "📋", "試合"],
    ["stats",  "📊", "分析"],
    ["master", "🗂",  "設定"],
  ];
  return (
    <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:10 }}>
      {items.map(([key,icon,label])=>(
        <div key={key} onClick={()=>onNavigate&&onNavigate(key)} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"6px 0 4px",fontSize:9,fontWeight:600,color:active===key?C.accent:C.textSec,cursor:"pointer",userSelect:"none",WebkitUserSelect:"none",WebkitTouchCallout:"none" }}>
          <span style={{ fontSize:20 }}>{icon}</span>{label}
        </div>
      ))}
    </div>
  );
}

// ★試合終了後のスコア修正：ポイントをタップした際に開く編集モーダル
function PointEditModal({ mode="edit", point, players, teamALabel, teamBLabel, onClose, onSave, onDelete }) {
  const [team,   setTeam]   = useState(point.scoring_team || "A");
  const [play,   setPlay]   = useState(point.play_type);
  const [side,   setSide]   = useState(point.side_type);
  const [result, setResult] = useState(point.result_type);
  const [playerName, setPlayerName] = useState(point.player_name);

  function handleSave(){
    const isWin = result ? isWinnerResult(result) : null;
    onSave({ scoring_team:team, play_type:play, side_type:side, result_type:result, player_name:playerName, is_winner:isWin });
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ maxHeight:"72vh", overflowY:"auto" }}>
        <h3 style={{ fontSize:16,fontWeight:800,marginBottom:14,textAlign:"center" }}>{mode==="add"?"ポイントを追加":"ポイントを修正"}</h3>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>得点チーム</div>
          <div style={{ display:"flex",gap:8 }}>
            <button style={{ ...S.togBtn(team==="A"),flex:1 }} onClick={()=>setTeam("A")}>{teamALabel||"自チーム"}</button>
            <button style={{ ...S.togBtn(team==="B"),flex:1 }} onClick={()=>setTeam("B")}>{teamBLabel||"相手"}</button>
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容</div>
          <div>
            {PLAY_TYPES.map(p=>(
              <span key={p.key} style={S.chip(play===p.key)} onClick={()=>setPlay(play===p.key?null:p.key)}>{p.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>フォア / バック</div>
          <div>
            {SIDE_TYPES.map(s=>(
              <span key={s.key} style={S.chip(side===s.key)} onClick={()=>setSide(side===s.key?null:s.key)}>{s.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>結果</div>
          <div>
            {RESULT_TYPES.map(r=>(
              <span key={r.key} style={S.chip(result===r.key)} onClick={()=>setResult(result===r.key?null:r.key)}>{r.label}</span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>選手</div>
          <div>
            {players.map(p=>(
              <span key={p.id} style={S.chip(playerName===p.name)} onClick={()=>setPlayerName(playerName===p.name?null:p.name)}>{p.name}</span>
            ))}
          </div>
        </div>

        <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:8 }} onClick={handleSave}>{mode==="add"?"追加する":"保存する"}</button>
        {mode==="edit" && (
          <button style={{ ...S.btn("#fff"),color:C.red,border:"1px solid "+C.red, marginBottom:8 }} onClick={onDelete}>🗑 このポイントを削除</button>
        )}
        <button style={{ ...S.btn("#f0f0f0"),color:C.text }} onClick={onClose}>キャンセル</button>
      </div>
    </Modal>
  );
}

// ============================================================
// 試合一覧
// ============================================================
function MatchList({ onNew, onOpen, onCopy, onProfile, onRoster, onSchoolAdmin, onNavigate, onStartScheduled, initialFilter, initialToast, onOpenTeamMatch, onNewTeamMatch, onCopyTeamMatch, initialMatchMode, onOpenTournament, initialShowTrash, onTrashConsumed }) {
  const [timeTab, setTimeTab] = useState(initialMatchMode || "tournament"); // tournament | team | individual
  const [childOnly, setChildOnly] = useState(false);
  const [allMatches, setAllMatches] = useState([]);
  const [allMatchesRaw, setAllMatchesRaw] = useState([]); // ★団体戦の番手も含む「全試合」。個人戦一覧(allMatches)からは除外されるため別途保持
  const [allTeamMatches, setAllTeamMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(null);
  const [serveSelectMatch, setServeSelectMatch] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myId, setMyId] = useState(null);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [mySchoolName, setMySchoolName] = useState("");
  const [mySchoolId, setMySchoolId] = useState(null);
  const [tmMySchoolOnly, setTmMySchoolOnly] = useState(false); // 自校のみ絞り込み
  const [toast, setToast] = useState(initialToast || null);
  useEffect(() => { if (toast) { const t = setTimeout(()=>setToast(null), 3000); return ()=>clearTimeout(t); } }, [toast]);
  // 共通絞り込み（個人戦・団体戦で共有）
  const [filterSearch, setFilterSearch] = useState("");       // フリーワード
  const [filterStatus, setFilterStatus] = useState("all");   // all | upcoming | finished
  // 日付フィルタ
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [dateFilterMode, setDateFilterMode] = useState("day"); // day | range | month
  const [dateFilterDay, setDateFilterDay] = useState(null);
  const [dateFilterRangeStart, setDateFilterRangeStart] = useState(null);
  const [dateFilterRangeEnd, setDateFilterRangeEnd] = useState(null);
  const [dateFilterMonth, setDateFilterMonth] = useState(null); // "YYYY-MM"
  const [dateFilterApplied, setDateFilterApplied] = useState(null);
  const [calViewYear, setCalViewYear] = useState(new Date().getFullYear());
  const [calViewMonth, setCalViewMonth] = useState(new Date().getMonth()); // 0-11
  const [rangeStep, setRangeStep] = useState("start"); // "start" | "end"
  const [monthViewYear, setMonthViewYear] = useState(new Date().getFullYear());

  const [schoolMap, setSchoolMap] = useState({}); // school_id -> name

  // 大会タブ関連
  const [tournaments, setTournaments] = useState([]);
  const [tournamentSearch, setTournamentSearch] = useState("");
  const [tournamentDropdownOpen, setTournamentDropdownOpen] = useState(false);
  const [showTournamentModal, setShowTournamentModal] = useState(false);
  const [editingTournament, setEditingTournament] = useState(null); // null=新規作成 / オブジェクト=編集
  const [confirmDeleteTournament, setConfirmDeleteTournament] = useState(null);
  const [showTrash, setShowTrash] = useState(false);
  const [trashTab, setTrashTab] = useState("tournament"); // tournament | team | individual
  const [deletedTournaments, setDeletedTournaments] = useState([]);
  const [deletedTeamMatches, setDeletedTeamMatches] = useState([]);
  const [deletedMatches, setDeletedMatches] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(null); // { kind, id }

  const reload = useCallback(() => {
    setLoading(true);
    purgeExpiredTrash(); // ★期限切れ（24時間経過）のゴミ箱を裏で自動削除
    Promise.all([getMatches(), getTeamMatches(), getSchools(), getTournaments()]).then(async ([list, tList, schools, tnList]) => {
      // 学校IDから名前へのマップを作成
      const smap = {};
      (schools || []).forEach(s => { smap[s.id] = s.name; });
      setSchoolMap(smap);
      setTournaments(tnList || []);
      setAllMatchesRaw(list);
      // 団体戦に紐付いたmatch_idを個人戦一覧から除外
      try {
        const { data: tmGames } = await supabase
          .from("team_match_games")
          .select("match_id")
          .not("match_id", "is", null);
        const teamMatchIds = new Set((tmGames || []).map(g => g.match_id).filter(Boolean));
        setAllMatches(list.filter(m => !teamMatchIds.has(m.id)));
      } catch(e) {
        setAllMatches(list);
      }
      setAllTeamMatches(tList);
      setLoading(false);
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    (async () => {
      const p = await getMyProfile();
      setIsAdmin(!!p?.is_admin);
      setMyId(p?.id ?? null);
      if (p?.linked_player_id) {
        const roster = await getPlayerRoster();
        const found = roster.find(r => r.id === p.linked_player_id);
        setLinkedPlayerName(found?.player_name ?? null);
      }
      if (p?.school_id) {
        setMySchoolId(p.school_id);
        const schools = await getSchools();
        const s = schools.find(s => s.id === p.school_id);
        if (s) setMySchoolName(s.name);
      }
    })();
  }, []);

  const todayStr = today();

  // 個人戦の振り分け
  const isUpcomingMatch = (m) => {
    if (m.status === "active" || m.status === "scheduled" || m.status === "waiting") return true;
    return false;
  };
  // 団体戦の振り分け（match_dateがnullでもactive/scheduledは予定・進行中）
  const isUpcomingTeamMatch = (tm) => {
    if (tm.status === "active" || tm.status === "scheduled") return true;
    return false;
  };

  // 日付フィルタ判定
  const matchesDateFilter = (dateStr) => {
    if (!dateFilterApplied || !dateStr) return true;
    if (dateFilterApplied.mode === "day") return dateStr === dateFilterApplied.day;
    if (dateFilterApplied.mode === "range") return dateStr >= dateFilterApplied.start && dateStr <= dateFilterApplied.end;
    if (dateFilterApplied.mode === "month") return dateStr.slice(0,7) === dateFilterApplied.month;
    return true;
  };
  // 日付フィルタのラベル表示
  const dateBadgeLabel = () => {
    if (!dateFilterApplied) return null;
    if (dateFilterApplied.mode === "day") return fmtDate(dateFilterApplied.day);
    if (dateFilterApplied.mode === "range") return `${fmtDate(dateFilterApplied.start)} 〜 ${fmtDate(dateFilterApplied.end)}`;
    if (dateFilterApplied.mode === "month") return `${dateFilterApplied.month.replace("-","年")}月`;
    return null;
  };

  // 大会の振り分け（開催期間の終了日が今日以降なら「予定・進行中」）
  const isUpcomingTournament = (t) => {
    const end = t.end_date || t.start_date;
    return !end || end >= todayStr;
  };
  // 大会は単日ではなく期間を持つため、期間が絞り込み条件と重なっているかで判定する
  const tournamentMatchesDateFilter = (t) => {
    if (!dateFilterApplied) return true;
    const s = t.start_date, e = t.end_date || t.start_date;
    if (!s) return true;
    if (dateFilterApplied.mode === "day") return dateFilterApplied.day >= s && dateFilterApplied.day <= e;
    if (dateFilterApplied.mode === "range") return s <= dateFilterApplied.end && e >= dateFilterApplied.start;
    if (dateFilterApplied.mode === "month") return s.slice(0,7) <= dateFilterApplied.month && e.slice(0,7) >= dateFilterApplied.month;
    return true;
  };

  // 共通絞り込みロジック
  const filteredMatches = allMatches.filter(m => {
    if (filterStatus === "upcoming" && !isUpcomingMatch(m)) return false;
    if (filterStatus === "finished" && isUpcomingMatch(m)) return false;
    if (!matchesDateFilter(m.match_date)) return false;
    if (childOnly && linkedPlayerName && !m.players.some(p => p.player_name === linkedPlayerName && p.team==="A")) return false;
    if (filterSearch.trim()) {
      const q = filterSearch.trim().toLowerCase();
      const players = m.players.map(p => p.player_name).join(" ").toLowerCase();
      const tour = (m.tournament_name || "").toLowerCase();
      const opp = m.players.filter(p=>p.team==="B").map(p=>p.club_name||"").join(" ").toLowerCase();
      if (!players.includes(q) && !tour.includes(q) && !opp.includes(q)) return false;
    }
    return true;
  });

  // ★団体戦の各番手(game)の選手名は、a_player1等の列ではなく、
  //   game.match_id が指す matches の match_players（=allMatchesRawのm.players）にある。
  //   allMatchesは団体戦の番手を除外した「個人戦のみ」の一覧なので、ここではallMatchesRawを使う。
  const matchPlayersByMatchId = {};
  allMatchesRaw.forEach(m => { matchPlayersByMatchId[m.id] = m.players; });
  const teamMatchHasPlayer = (tm, name) => (tm.games || []).some(g =>
    (matchPlayersByMatchId[g.match_id] || []).some(p => p.player_name === name && p.team==="A")
  );

  const filteredTeamMatches = allTeamMatches.filter(tm => {
    if (filterStatus === "upcoming" && !isUpcomingTeamMatch(tm)) return false;
    if (filterStatus === "finished" && isUpcomingTeamMatch(tm)) return false;
    if (!matchesDateFilter(tm.match_date)) return false;
    if (childOnly && linkedPlayerName && !teamMatchHasPlayer(tm, linkedPlayerName)) return false;
    if (tmMySchoolOnly && mySchoolId) {
      // my_school_idがnullの場合はプロフィールの学校の試合とみなす
      const tmSchoolId = tm.my_school_id || mySchoolId;
      if (tmSchoolId !== mySchoolId) return false;
    }
    if (filterSearch.trim()) {
      const q = filterSearch.trim().toLowerCase();
      const opp = (tm.opponent_name || "").toLowerCase();
      const tour = (tm.tournament_name || "").toLowerCase();
      if (!opp.includes(q) && !tour.includes(q)) return false;
    }
    return true;
  });



  async function handleDelete(id) {
    const link = await getDrawMatchByMatchId(id).catch(()=>null);
    await deleteMatch(id);
    if (link) await clearDrawMatchLink(link.id).catch(()=>{});
    setConfirmDelete(null);
    reload();
  }

  // 大会ごとの団体戦・個人戦の件数（大会名の一致で集計）
  const countsForTournament = (name) => ({
    team: allTeamMatches.filter(tm => tm.tournament_name === name).length,
    individual: allMatches.filter(m => m.tournament_name === name).length,
  });

  const filteredTournaments = tournaments.filter(t => {
    if (tournamentSearch.trim() && !t.name.toLowerCase().includes(tournamentSearch.trim().toLowerCase())) return false;
    if (filterStatus === "upcoming" && !isUpcomingTournament(t)) return false;
    if (filterStatus === "finished" && isUpcomingTournament(t)) return false;
    if (!tournamentMatchesDateFilter(t)) return false;
    if (childOnly && linkedPlayerName) {
      const hasInIndividual = allMatches.some(m => m.tournament_name===t.name && m.players.some(p=>p.player_name===linkedPlayerName && p.team==="A"));
      const hasInTeam = allTeamMatches.some(tm => tm.tournament_name===t.name && teamMatchHasPlayer(tm, linkedPlayerName));
      if (!hasInIndividual && !hasInTeam) return false;
    }
    return true;
  });

  async function handleSaveTournament(name, startDate, endDate, venue) {
    const trimmed = name.trim();
    if (!trimmed) { alert("大会名を入力してください"); return; }
    if (!startDate) { alert("開始日を選択してください"); return; }
    try {
      await saveTournament({
        id: editingTournament?.id,
        name: trimmed,
        start_date: startDate,
        end_date: endDate || startDate,
        venue: venue || null,
      });
      // ★既存の大会の名前を変更した場合、紐づく個人戦・団体戦の大会名も追従させる
      if (editingTournament?.name && editingTournament.name.trim() !== trimmed) {
        await renameTournamentCascade(editingTournament.name, trimmed);
      }
      setShowTournamentModal(false);
      setEditingTournament(null);
      reload();
    } catch(e) {
      alert("保存エラー: " + (e.message || e));
    }
  }

  async function handleDeleteTournament(id) {
    await deleteTournament(id);
    setConfirmDeleteTournament(null);
    reload();
  }

  function openTrash() {
    setShowTrash(true);
    setTrashTab(timeTab === "team" ? "team" : timeTab === "individual" ? "individual" : "tournament");
    setTrashLoading(true);
    Promise.all([getDeletedTournaments(), getDeletedTeamMatches(), getDeletedMatches()]).then(([tn, tm, mt]) => {
      setDeletedTournaments(tn); setDeletedTeamMatches(tm); setDeletedMatches(mt);
      setTrashLoading(false);
    });
  }
  // ★設定画面の「ゴミ箱」から遷移してきた場合、自動的にゴミ箱を開く
  useEffect(() => {
    if (initialShowTrash) {
      openTrash();
      onTrashConsumed && onTrashConsumed();
    }
  }, []);
  async function handleRestoreTournament(id) {
    await restoreTournament(id);
    setDeletedTournaments(list => list.filter(t => t.id !== id));
    reload();
  }
  async function handlePurgeTournament(id) {
    await permanentlyDeleteTournament(id);
    setDeletedTournaments(list => list.filter(t => t.id !== id));
    setConfirmPurge(null);
  }
  async function handleRestoreTeamMatch(id) {
    await restoreTeamMatch(id);
    setDeletedTeamMatches(list => list.filter(t => t.id !== id));
    reload();
  }
  async function handlePurgeTeamMatch(id) {
    await permanentlyDeleteTeamMatch(id);
    setDeletedTeamMatches(list => list.filter(t => t.id !== id));
    setConfirmPurge(null);
  }
  async function handleRestoreMatch(id) {
    await restoreMatch(id);
    setDeletedMatches(list => list.filter(t => t.id !== id));
    reload();
  }
  async function handlePurgeMatch(id) {
    await permanentlyDeleteMatch(id);
    setDeletedMatches(list => list.filter(t => t.id !== id));
    setConfirmPurge(null);
  }

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>試合一覧</span>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {linkedPlayerName && (
            <button onClick={()=>setChildOnly(v=>!v)} style={{ padding:"4px 10px", borderRadius:20, border:"1px solid "+(childOnly?"#fff":"rgba(255,255,255,0.4)"), background:childOnly?"#fff":"transparent", color:childOnly?C.navy:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>{linkedPlayerName}</button>
          )}
          {mySchoolName && timeTab==="team" && (
            <button onClick={()=>setTmMySchoolOnly(v=>!v)} style={{ padding:"4px 10px", borderRadius:20, border:"1px solid "+(tmMySchoolOnly?"#fff":"rgba(255,255,255,0.4)"), background:tmMySchoolOnly?"#fff":"transparent", color:tmMySchoolOnly?C.navy:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>{mySchoolName}</button>
          )}
          <button style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:13, padding:"6px 10px", cursor:"pointer" }} onClick={reload}>🔄 更新</button>
        </div>
      </div>
      {toast && <div style={{ position:"fixed", top:60, left:"50%", transform:"translateX(-50%)", background:"#1b5e20", color:"#fff", padding:"10px 20px", borderRadius:20, fontSize:13, fontWeight:700, zIndex:9999, boxShadow:"0 4px 12px rgba(0,0,0,0.2)", whiteSpace:"nowrap" }}>{toast}</div>}

      {/* 上段：大会 / 団体戦 / 個人戦 タブ */}
      <div style={{ display:"flex", alignItems:"center", gap:8, margin:"10px 14px 0" }}>
        <div style={{ flex:1, display:"flex", background:"#f0f2f6", padding:3, borderRadius:10 }}>
          {[["tournament","📋 大会"],["team","🏆 団体戦"],["individual","🎾 個人戦"]].map(([v,l])=>(
            <button key={v} style={{ flex:1, padding:9, border:"none", cursor:"pointer", borderRadius:8, fontSize:13, fontWeight:700, background:timeTab===v||(!["tournament","individual","team"].includes(timeTab)&&v==="tournament")?C.white:"transparent", color:timeTab===v?C.navy:C.textSec, boxShadow:timeTab===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>{ setTimeTab(v); }}>{l}</button>
          ))}
        </div>
      </div>

      {/* 共通絞り込みUI（大会タブでは検索欄のみ非表示。ステータス・日付絞り込みは大会タブにも表示） */}
      <div style={{ padding:"10px 14px 0" }}>
        {timeTab !== "tournament" && (
        <div style={{ display:"flex", alignItems:"center", background:C.white, border:"1px solid "+C.border, borderRadius:10, padding:"6px 10px", marginBottom:8 }}>
          <span style={{ fontSize:14, marginRight:6, color:C.textSec }}>🔍</span>
          <input
            value={filterSearch}
            onChange={e=>setFilterSearch(e.target.value)}
            placeholder={timeTab==="team" ? "学校名・大会名で検索" : "選手名・相手校・大会名で検索"}
            style={{ flex:1, border:"none", outline:"none", fontSize:13, color:C.text, background:"transparent" }}
          />
          {filterSearch && <button onClick={()=>setFilterSearch("")} style={{ border:"none", background:"none", color:C.textSec, fontSize:16, cursor:"pointer", padding:"0 2px" }}>✕</button>}
        </div>
        )}
        <div style={{ display:"flex", gap:6, marginBottom:6, flexWrap:"wrap" }}>
          {[["all","すべて"],["upcoming","予定・進行中"],["finished","完了"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilterStatus(v)} style={{ padding:"4px 12px", borderRadius:20, border:"1px solid "+(filterStatus===v?C.navy:C.border), background:filterStatus===v?C.navy:"transparent", color:filterStatus===v?C.white:C.textSec, fontSize:12, fontWeight:700, cursor:"pointer" }}>{l}</button>
          ))}
          {/* 日付フィルタボタン（ステータスボタンと同行・同スタイル） */}
          {dateFilterApplied ? (
            <div style={{ display:"inline-flex", alignItems:"center", gap:2, padding:"4px 10px", borderRadius:20, border:"1px solid "+C.navy, background:C.navy, fontSize:12, fontWeight:700, color:C.white }}>
              <span onClick={()=>setDateFilterOpen(v=>!v)} style={{ cursor:"pointer" }}>{dateBadgeLabel()}</span>
              <span onClick={()=>{ setDateFilterApplied(null); setDateFilterOpen(false); }} style={{ cursor:"pointer", marginLeft:4, fontSize:13, opacity:0.8 }}>✕</span>
            </div>
          ) : (
            <button onClick={()=>setDateFilterOpen(v=>!v)} style={{ padding:"4px 12px", borderRadius:20, border:"1px solid "+C.border, background:"transparent", fontSize:12, fontWeight:700, color:C.textSec, cursor:"pointer" }}>日付</button>
          )}
        </div>
        {/* 日付ピッカーパネル */}
        {dateFilterOpen && (() => {
          const daysInMonth = new Date(calViewYear, calViewMonth+1, 0).getDate();
          const firstDow = new Date(calViewYear, calViewMonth, 1).getDay(); // 0=日
          const todayIso = today();
          const padMonth = (m) => String(m+1).padStart(2,"0");
          const toIso = (d) => `${calViewYear}-${padMonth(calViewMonth)}-${String(d).padStart(2,"0")}`;
          const handleDayClick = (d) => {
            const iso = toIso(d);
            if (dateFilterMode === "day") {
              setDateFilterDay(iso);
            } else if (dateFilterMode === "range") {
              if (rangeStep === "start") {
                setDateFilterRangeStart(iso); setDateFilterRangeEnd(null); setRangeStep("end");
              } else {
                if (iso < dateFilterRangeStart) { setDateFilterRangeStart(iso); setRangeStep("end"); }
                else { setDateFilterRangeEnd(iso); setRangeStep("start"); }
              }
            }
          };
          const getDayClass = (iso) => {
            if (dateFilterMode === "day") return iso === dateFilterDay ? "sel" : "";
            if (dateFilterMode === "range") {
              if (iso === dateFilterRangeStart) return "rs";
              if (iso === dateFilterRangeEnd) return "re";
              if (dateFilterRangeStart && dateFilterRangeEnd && iso > dateFilterRangeStart && iso < dateFilterRangeEnd) return "ir";
            }
            return "";
          };
          const applyFilter = () => {
            if (dateFilterMode === "day" && dateFilterDay) {
              setDateFilterApplied({ mode:"day", day:dateFilterDay });
              setDateFilterOpen(false);
            } else if (dateFilterMode === "range" && dateFilterRangeStart && dateFilterRangeEnd) {
              setDateFilterApplied({ mode:"range", start:dateFilterRangeStart, end:dateFilterRangeEnd });
              setDateFilterOpen(false);
            } else if (dateFilterMode === "month" && dateFilterMonth) {
              setDateFilterApplied({ mode:"month", month:dateFilterMonth });
              setDateFilterOpen(false);
            }
          };
          const canApply = (dateFilterMode==="day"&&dateFilterDay)||(dateFilterMode==="range"&&dateFilterRangeStart&&dateFilterRangeEnd)||(dateFilterMode==="month"&&dateFilterMonth);
          const DOW = ["日","月","火","水","木","金","土"];
          return (
            <div style={{ background:C.white, borderRadius:14, border:"1.5px solid "+C.border, overflow:"hidden", boxShadow:"0 2px 8px rgba(0,0,0,0.07)", marginBottom:8 }}>
              {/* タブ */}
              <div style={{ display:"flex", borderBottom:"1.5px solid "+C.border }}>
                {[["day","1日指定"],["range","期間指定"],["month","月指定"]].map(([v,l])=>(
                  <button key={v} onClick={()=>{ setDateFilterMode(v); if(v==="range"){setDateFilterRangeStart(null);setDateFilterRangeEnd(null);setRangeStep("start");} }} style={{ flex:1, padding:"10px 4px", textAlign:"center", fontSize:13, fontWeight:700, color:dateFilterMode===v?C.accent:C.textSec, border:"none", background:"none", cursor:"pointer", borderBottom:dateFilterMode===v?"2px solid "+C.accent:"2px solid transparent" }}>{l}</button>
                ))}
              </div>
              <div style={{ padding:"12px 14px 0" }}>
                {/* 1日指定 / 期間指定：カレンダー */}
                {(dateFilterMode==="day"||dateFilterMode==="range") && (<>
                  {dateFilterMode==="range" && (
                    <p style={{ fontSize:11, color:C.textSec, textAlign:"center", marginBottom:8 }}>
                      {rangeStep==="start" ? <>開始日 → 終了日の順にタップ（<b style={{color:C.accent}}>開始日</b>を選択中）</> : <>開始日 → 終了日の順にタップ（<b style={{color:C.accent}}>終了日</b>を選択中）</>}
                    </p>
                  )}
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                    <button onClick={()=>{ if(calViewMonth===0){setCalViewMonth(11);setCalViewYear(y=>y-1);}else setCalViewMonth(m=>m-1); }} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:C.navy, padding:"4px 8px" }}>‹</button>
                    <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{calViewYear}年{calViewMonth+1}月</span>
                    <button onClick={()=>{ if(calViewMonth===11){setCalViewMonth(0);setCalViewYear(y=>y+1);}else setCalViewMonth(m=>m+1); }} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:C.navy, padding:"4px 8px" }}>›</button>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:10 }}>
                    {DOW.map((d,i)=>(
                      <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:700, color:i===0?"#e53935":i===6?"#1565c0":C.textSec, padding:"3px 0" }}>{d}</div>
                    ))}
                    {Array.from({length:firstDow}).map((_,i)=><div key={"e"+i}/>)}
                    {Array.from({length:daysInMonth}).map((_,i)=>{
                      const d=i+1; const iso=toIso(d); const dc=getDayClass(iso);
                      const dow=(firstDow+i)%7;
                      const isToday=iso===todayIso;
                      const isSel=dc==="sel"||dc==="rs"||dc==="re";
                      const isInRange=dc==="ir";
                      return (
                        <button key={d} onClick={()=>handleDayClick(d)} style={{
                          textAlign:"center", fontSize:13, padding:"7px 2px", borderRadius: dc==="rs"?"8px 0 0 8px":dc==="re"?"0 8px 8px 0":"8px",
                          cursor:"pointer", fontWeight:600, border:"none",
                          background:isSel?C.accent:isInRange?C.accentL:"transparent",
                          color:isSel?"#fff":isInRange?"#00874f":dow===0?"#e53935":dow===6?"#1565c0":isToday?C.accent:C.text,
                          outline:isToday&&!isSel?"1.5px solid "+C.accent:"none",
                        }}>{d}</button>
                      );
                    })}
                  </div>
                </>)}
                {/* 月指定 */}
                {dateFilterMode==="month" && (<>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16, marginBottom:10 }}>
                    <button onClick={()=>setMonthViewYear(y=>y-1)} style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:C.navy }}>‹</button>
                    <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{monthViewYear}年</span>
                    <button onClick={()=>setMonthViewYear(y=>y+1)} style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:C.navy }}>›</button>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:10 }}>
                    {Array.from({length:12}).map((_,i)=>{
                      const mStr=`${monthViewYear}-${String(i+1).padStart(2,"0")}`;
                      const isSel=dateFilterMonth===mStr;
                      const hasData=[...allMatches,...allTeamMatches].some(m=>(m.match_date||"").slice(0,7)===mStr);
                      return (
                        <button key={i} onClick={()=>setDateFilterMonth(mStr)} style={{ padding:"10px 4px", textAlign:"center", borderRadius:8, cursor:"pointer", fontSize:14, fontWeight:700, border: isSel?"1.5px solid "+C.accent:hasData?"1.5px solid "+C.accent:"1.5px solid "+C.border, background:isSel?C.accent:"#fff", color:isSel?"#fff":hasData?"#00874f":C.text }}>{i+1}月</button>
                      );
                    })}
                  </div>
                  <p style={{ fontSize:11, color:C.textSec, textAlign:"center", marginBottom:10 }}>枠線あり＝試合データあり</p>
                </>)}
              </div>
              <div style={{ padding:"0 14px 14px", display:"flex", gap:8 }}>
                <button onClick={()=>setDateFilterOpen(false)} style={{ padding:"10px 14px", background:"#f0f2f6", color:C.textSec, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}>閉じる</button>
                <button onClick={applyFilter} disabled={!canApply} style={{ flex:1, padding:"10px", background:canApply?C.accent:"#ccc", color:"#fff", border:"none", borderRadius:10, fontSize:14, fontWeight:800, cursor:canApply?"pointer":"default" }}>この条件で絞り込む</button>
              </div>
            </div>
          );
        })()}
      </div>

      {/* 大会タブ */}
      {timeTab === "tournament" && (
        <>
          <div style={{ position:"relative", margin:"10px 14px 8px" }}>
            <div style={{ display:"flex", alignItems:"center", background:C.white, border:"1px solid "+C.border, borderRadius:10, padding:"6px 10px" }}>
              <span style={{ fontSize:14, color:C.textSec }}>🔍</span>
              <input
                value={tournamentSearch}
                onChange={e=>setTournamentSearch(e.target.value)}
                placeholder="キーワード／大会一覧から選択"
                style={{ flex:1, marginLeft:6, border:"none", outline:"none", fontSize:13, color:C.text, background:"transparent" }}
              />
              {tournamentSearch && (
                <button onClick={()=>{ setTournamentSearch(""); setTournamentDropdownOpen(false); }} style={{ border:"none", background:"none", color:C.textSec, fontSize:16, cursor:"pointer", padding:"2px 6px" }} title="絞り込みをクリア">✕</button>
              )}
              <button onClick={()=>setTournamentDropdownOpen(v=>!v)} style={{ border:"none", background:"none", color:C.textSec, fontSize:14, cursor:"pointer", padding:"2px 4px" }}>{tournamentDropdownOpen ? "▲" : "▼"}</button>
            </div>
            {tournamentDropdownOpen && (
              <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:C.white, border:"1px solid "+C.border, borderRadius:10, boxShadow:"0 4px 16px rgba(0,0,0,0.12)", zIndex:20, maxHeight:220, overflowY:"auto" }}>
                {tournaments.length===0 ? (
                  <div style={{ padding:"12px 14px", fontSize:12, color:C.textSec }}>大会がまだありません</div>
                ) : tournaments.filter(t => !tournamentSearch.trim() || t.name.toLowerCase().includes(tournamentSearch.trim().toLowerCase())).length===0 ? (
                  <div style={{ padding:"12px 14px", fontSize:12, color:C.textSec }}>一致する大会がありません</div>
                ) : tournaments.filter(t => !tournamentSearch.trim() || t.name.toLowerCase().includes(tournamentSearch.trim().toLowerCase())).map(t => (
                  <div key={t.id} onClick={()=>{ setTournamentSearch(t.name); setTournamentDropdownOpen(false); }} style={{ padding:"11px 14px", fontSize:13, color:C.text, cursor:"pointer", borderBottom:"1px solid "+C.border }}>{t.name}</div>
                ))}
              </div>
            )}
          </div>
          <div style={{ padding:"0 14px", paddingBottom:90 }}>
            {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}
            {!loading && tournaments.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>📋</div>大会がまだありません</div>}
            {!loading && tournaments.length>0 && filteredTournaments.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}><div style={{ fontSize:32,marginBottom:8 }}>🔍</div>条件に合う大会がありません</div>}
            {!loading && filteredTournaments.map(t => {
              const counts = countsForTournament(t.name);
              return (
                <div key={t.id} style={{ ...S.card, marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
                  <div style={{ height:4, background:C.navy }}/>
                  <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpenTournament && onOpenTournament(t)}>
                    <div style={{ fontSize:16, fontWeight:800, color:C.text }}>{t.name}</div>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
                      <span style={{ fontSize:11, color:C.textSec }}>📅 {fmtDateRange(t.start_date, t.end_date)}</span>
                      <div style={{ display:"flex", gap:4 }}>
                        {counts.team>0 && <span style={{ fontSize:10, color:C.textSec, background:"#f0f0f0", padding:"2px 8px", borderRadius:10 }}>🏆 団体 {counts.team}</span>}
                        {counts.individual>0 && <span style={{ fontSize:10, color:C.textSec, background:"#f0f0f0", padding:"2px 8px", borderRadius:10 }}>🎾 個人 {counts.individual}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display:"flex", borderTop:"1px solid "+C.border }}>
                    <button style={{ flex:1, padding:"8px", background:"#f5f5f5", color:C.navy, border:"none", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={()=>onOpenTournament && onOpenTournament(t)}>📂 試合一覧を見る</button>
                    <button style={{ width:48, padding:"8px", background:"#eef0f4", color:C.textSec, border:"none", borderLeft:"1px solid "+C.border, fontSize:14, cursor:"pointer" }} onClick={e=>{e.stopPropagation();setEditingTournament(t);setShowTournamentModal(true);}}>✏️</button>
                    <button style={{ width:60, padding:"8px", background:"#fdecea", color:C.red, border:"none", borderLeft:"1px solid "+C.border, fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e=>{e.stopPropagation();setConfirmDeleteTournament(t.id);}}>🗑</button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* 大会FAB */}
          <button style={{ position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.navy},${C.navyMid})`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(15,32,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={()=>{ setEditingTournament(null); setShowTournamentModal(true); }}>＋</button>
        </>
      )}

      {/* 個人戦タブ */}
      {timeTab === "individual" && (
        <>
          <div style={{ padding:"8px 14px", paddingBottom:90 }}>
            {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}
            {!loading && allMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🎾</div>試合記録がありません</div>}
            {!loading && allMatches.length>0 && filteredMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}><div style={{ fontSize:32,marginBottom:8 }}>🔍</div>条件に合う試合がありません</div>}
            {!loading && filteredMatches.map(m => {
              const aWin = m.status==="finished" && m.match_score_a > m.match_score_b;
              const bWin = m.status==="finished" && m.match_score_b > m.match_score_a;
              const aPlayers = m.players.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num);
              const bPlayers = m.players.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num);
              const aNames = aPlayers.map(p=>p.player_name).join("/");
              const bNames = bPlayers.map(p=>p.player_name).join("/");
              const aClub = aPlayers[0]?.club_name || "";
              const bClub = bPlayers[0]?.club_name || "";
              const borderColor = m.status==="active" ? C.orange : m.status==="waiting" ? C.purple : m.status==="scheduled" ? C.accent : m.status==="abandoned" ? C.textSec : m.status==="suspended" ? C.textSec : aWin ? C.teamA : bWin ? C.teamB : C.border;
              const isMyMatch = m.created_by === myId;
              return (
                <div key={m.id} style={{ ...S.card, marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
                  <div style={{ height:4, background:borderColor }}/>
                  <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, gap:8 }}>
                      <span style={{ fontSize:11, color:C.textSec, flex:1, minWidth:0 }}>{fmtDate(m.match_date)}{m.tournament_name ? ` · ${m.tournament_name}` : ""}</span>
                      <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                        {m.status==="active" && <span style={{ fontSize:10, color:C.orange, fontWeight:700, background:"#fff3e0", padding:"1px 8px", borderRadius:10, whiteSpace:"nowrap" }}>🔴 進行中</span>}
                        {m.status==="waiting" && <span style={{ fontSize:10, color:C.purple, fontWeight:700, background:"#eef0fe", padding:"1px 8px", borderRadius:10, whiteSpace:"nowrap" }}>⏳ 待機中</span>}
                        {m.status==="scheduled" && <span style={{ fontSize:10, color:C.accent, fontWeight:700, background:"#e8f5e9", padding:"1px 8px", borderRadius:10, whiteSpace:"nowrap" }}>予定</span>}
                        {m.status==="suspended" && <span style={{ fontSize:10, color:C.textSec, fontWeight:700, whiteSpace:"nowrap" }}>中断 {m.match_score_a}-{m.match_score_b}</span>}
                        {m.status==="abandoned" && <span style={{ fontSize:10, color:C.textSec, fontWeight:700, whiteSpace:"nowrap" }}>途中終了 {m.match_score_a}-{m.match_score_b}</span>}
                        <span style={{ fontSize:10, color:C.textSec, background:"#f0f0f0", padding:"1px 6px", borderRadius:6, whiteSpace:"nowrap" }}>{m.game_format}G</span>
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:13, fontWeight:aWin?800:600, color:aWin?C.teamA:C.text }}>{aClub && <span style={{ fontSize:11, color:C.textSec, marginRight:6 }}>{aClub}</span>}{aNames}</div>
                        <div style={{ fontSize:13, fontWeight:bWin?800:600, color:bWin?C.teamB:C.text, marginTop:2 }}>{bClub && <span style={{ fontSize:11, color:C.textSec, marginRight:6 }}>{bClub}</span>}{bNames}</div>
                      </div>
                      {m.status!=="scheduled" && m.status!=="waiting" && <div style={{ fontSize:22, fontWeight:900, color:aWin?C.teamA:bWin?C.teamB:C.textSec, minWidth:48, textAlign:"right" }}>{m.match_score_a}-{m.match_score_b}</div>}
                    </div>
                  </div>
                  <div style={{ display:"flex", borderTop:"1px solid "+C.border }}>
                    <button style={{ flex:1, padding:"8px", background:"#f5f5f5", color:C.navy, border:"none", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e=>{e.stopPropagation();onCopy(m.id);}}>📋 コピーして新規作成</button>
                    <button style={{ width:60, padding:"8px", background:"#fdecea", color:C.red, border:"none", borderLeft:"1px solid "+C.border, fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e=>{e.stopPropagation();setConfirmDelete(m.id);}}>🗑</button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* 個人戦FAB */}
          <button style={{ position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.navy},${C.navyMid})`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(15,32,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={()=>onNew()}>＋</button>
        </>
      )}

      {/* 団体戦タブ */}
      {timeTab === "team" && (
        <>
          <div style={{ padding:"8px 14px", paddingBottom:90 }}>
            {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}
            {!loading && allTeamMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🏆</div>団体戦の記録がありません</div>}
            {!loading && allTeamMatches.length>0 && filteredTeamMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}><div style={{ fontSize:32,marginBottom:8 }}>🔍</div>条件に合う団体戦がありません</div>}
            {!loading && filteredTeamMatches.map(tm => {
              const myFullLabel = [(tm.my_school_id ? schoolMap[tm.my_school_id] : null) || mySchoolName || "自チーム", tm.my_team_division].filter(Boolean).join("");
              const oppLabel = [tm.opponent_name, tm.opponent_division].filter(Boolean).join("");
              const statusColor = tm.status === "finished" ? (tm.my_score > tm.opponent_score ? C.teamA : C.teamB) : tm.status === "active" ? C.orange : C.accent;
              const statusLabel = tm.status === "finished" ? (tm.my_score > tm.opponent_score ? "勝利" : tm.my_score < tm.opponent_score ? "敗北" : "全試合終了") : tm.status === "active" ? "⏳ 進行中" : "📅 予定";
              return (
                <div key={tm.id} style={{ ...S.card, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:10 }}>
                  <div style={{ height:4, background:statusColor }}/>
                  <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpenTeamMatch && onOpenTeamMatch(tm.id)}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                      <span style={{ fontSize:12, fontWeight:700 }}>{tm.tournament_name || "団体戦"}{tm.round ? ` · ${tm.round}` : ""}</span>
                      <span style={{ fontSize:11, color:C.textSec }}>{fmtDate(tm.match_date)}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, marginBottom:6 }}>
                      <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1, textAlign:"right" }}>{myFullLabel}</span>
                      <span style={{ fontSize:20, fontWeight:900, color:statusColor, minWidth:48, textAlign:"center" }}>{tm.my_score??0}-{tm.opponent_score??0}</span>
                      <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1 }}>{oppLabel || "相手"}</span>
                    </div>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <span style={{ fontSize:11, padding:"2px 10px", borderRadius:20, background:statusColor+"22", color:statusColor, fontWeight:700 }}>{statusLabel}</span>
                      <span style={{ fontSize:10, color:C.textSec }}>{tm.format === "best2" ? "2勝先取" : "3試合全部"} ・ {tm.is_younger===false ? "遅番" : tm.is_younger===true ? "若番" : "若番/遅番未設定"}</span>
                    </div>
                  </div>
                  <div style={{ display:"flex", borderTop:"1px solid "+C.border }}>
                    <button style={{ flex:1, padding:"8px", background:"#f5f5f5", color:C.navy, border:"none", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e=>{e.stopPropagation();onCopyTeamMatch&&onCopyTeamMatch(tm.id);}}>📋 コピーして新規作成</button>
                    <button style={{ width:60, padding:"8px", background:"#fdecea", color:C.red, border:"none", borderLeft:"1px solid "+C.border, fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e=>{e.stopPropagation();setConfirmDeleteTeam(tm.id);}}>🗑</button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* 団体戦FAB */}
          <button style={{ position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.navy},${C.navyMid})`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(15,32,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={()=>onNewTeamMatch&&onNewTeamMatch()}>＋</button>
        </>
      )}

      <NavBar active="list" onNavigate={onNavigate}/>

      {serveSelectMatch && (
        <Modal onClose={()=>setServeSelectMatch(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
            <h3 style={{ fontSize:16, fontWeight:800, margin:"8px 0 4px" }}>最初のサーブを選択</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:16 }}>試合を開始するにはサーブ側を選んでください</p>
            <div style={{ display:"flex", gap:10, marginBottom:12 }}>
              {[["A", serveSelectMatch.players?.filter(p=>p.team==="A").map(p=>p.player_name).join("/") || "自チーム"],
                ["B", serveSelectMatch.players?.filter(p=>p.team==="B").map(p=>p.player_name).join("/") || "相手チーム"]
              ].map(([team, label]) => (
                <button key={team} style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?"#2ecc71":"#f97316"}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?"#2ecc71":"#f97316" }}
                  onClick={async ()=>{ const m = serveSelectMatch; setServeSelectMatch(null); await onStartScheduled(m.id, team); }}
                >{label}<br/><span style={{ fontSize:11, fontWeight:400 }}>（サーブ）</span></button>
              ))}
            </div>
            <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:12 }} onClick={()=>setServeSelectMatch(null)}>キャンセル</button>
          </div>
        </Modal>
      )}
      {confirmDelete && (
        <Modal onClose={()=>setConfirmDelete(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この試合を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>ゴミ箱に移動します。24時間以内であれば元に戻せます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDelete(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>handleDelete(confirmDelete)}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
      {confirmDeleteTeam && (
        <Modal onClose={()=>setConfirmDeleteTeam(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この団体戦を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>ゴミ箱に移動します。24時間以内であれば元に戻せます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDeleteTeam(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={async()=>{ await deleteTeamMatch(confirmDeleteTeam); setConfirmDeleteTeam(null); reload(); }}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
      {showTournamentModal && (
        <Modal onClose={()=>{ setShowTournamentModal(false); setEditingTournament(null); }}>
          <TournamentFormFields
            initial={editingTournament}
            onCancel={()=>{ setShowTournamentModal(false); setEditingTournament(null); }}
            onSave={handleSaveTournament}
          />
        </Modal>
      )}
      {confirmDeleteTournament && (
        <Modal onClose={()=>setConfirmDeleteTournament(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この大会を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>大会の情報のみ削除されます。紐づく試合記録は削除されません。削除してもゴミ箱から元に戻せます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDeleteTournament(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>handleDeleteTournament(confirmDeleteTournament)}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
      {showTrash && (
        <Modal onClose={()=>setShowTrash(false)}>
          <div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:4 }}>🗑 ゴミ箱</h3>
            <p style={{ fontSize:11,color:C.textSec,marginBottom:10 }}>削除してから24時間以内であれば元に戻せます。24時間を過ぎると自動的に完全に削除されます。</p>
            <div style={{ display:"flex", background:"#f0f2f6", padding:3, borderRadius:10, marginBottom:12 }}>
              {[["tournament","📋 大会"],["team","🏆 団体戦"],["individual","🎾 個人戦"]].map(([v,l])=>(
                <button key={v} style={{ flex:1, padding:8, border:"none", cursor:"pointer", borderRadius:8, fontSize:12, fontWeight:700, background:trashTab===v?C.white:"transparent", color:trashTab===v?C.navy:C.textSec, boxShadow:trashTab===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>setTrashTab(v)}>{l}</button>
              ))}
            </div>

            {trashLoading && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>読み込み中...</div>}

            {!trashLoading && trashTab==="tournament" && (
              deletedTournaments.length===0 ? <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>ゴミ箱は空です</div> :
              deletedTournaments.map(t => (
                <div key={t.id} style={{ border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2 }}>{t.name}</div>
                  <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>{t.start_date}{t.end_date && t.end_date!==t.start_date ? `〜${t.end_date}` : ""}</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <button style={{ padding:"9px", background:C.accent, color:C.white, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>handleRestoreTournament(t.id)}>↩️ 元に戻す</button>
                    <button style={{ padding:"9px", background:"#f0f0f0", color:C.red, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>setConfirmPurge({ kind:"tournament", id:t.id })}>完全に削除</button>
                  </div>
                </div>
              ))
            )}

            {!trashLoading && trashTab==="team" && (
              deletedTeamMatches.length===0 ? <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>ゴミ箱は空です</div> :
              deletedTeamMatches.map(t => (
                <div key={t.id} style={{ border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2 }}>{t.opponent_name ? `vs ${t.opponent_name}` : "（対戦相手未設定）"}</div>
                  <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>{fmtDate(t.match_date)}{t.tournament_name ? ` ・ ${t.tournament_name}` : ""}</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <button style={{ padding:"9px", background:C.accent, color:C.white, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>handleRestoreTeamMatch(t.id)}>↩️ 元に戻す</button>
                    <button style={{ padding:"9px", background:"#f0f0f0", color:C.red, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>setConfirmPurge({ kind:"team", id:t.id })}>完全に削除</button>
                  </div>
                </div>
              ))
            )}

            {!trashLoading && trashTab==="individual" && (
              deletedMatches.length===0 ? <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>ゴミ箱は空です</div> :
              deletedMatches.map(t => (
                <div key={t.id} style={{ border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2 }}>{t.match_score_a}-{t.match_score_b}{t.tournament_name ? `　${t.tournament_name}` : ""}</div>
                  <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>{fmtDate(t.match_date)}</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <button style={{ padding:"9px", background:C.accent, color:C.white, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>handleRestoreMatch(t.id)}>↩️ 元に戻す</button>
                    <button style={{ padding:"9px", background:"#f0f0f0", color:C.red, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }} onClick={()=>setConfirmPurge({ kind:"individual", id:t.id })}>完全に削除</button>
                  </div>
                </div>
              ))
            )}

            <button style={{ padding:"11px", background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer", width:"100%", marginTop:6 }} onClick={()=>setShowTrash(false)}>閉じる</button>
          </div>
        </Modal>
      )}
      {confirmPurge && (
        <Modal onClose={()=>setConfirmPurge(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>完全に削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>この操作は元に戻せません。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmPurge(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>{
                if (confirmPurge.kind==="tournament") handlePurgeTournament(confirmPurge.id);
                else if (confirmPurge.kind==="team") handlePurgeTeamMatch(confirmPurge.id);
                else handlePurgeMatch(confirmPurge.id);
              }}>完全に削除する</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// 大会 作成/編集フォーム（モーダル内で使用）
function TournamentFormFields({ initial, onCancel, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [startDate, setStartDate] = useState(initial?.start_date || today());
  const [endDate, setEndDate] = useState(initial?.end_date || initial?.start_date || today());
  const [venue, setVenue] = useState(initial?.venue || "");
  const [venues, setVenues] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getKnownVenues().then(setVenues); }, []);
  return (
    <div>
      <h3 style={{ fontSize:16, fontWeight:800, marginBottom:14, textAlign:"center" }}>{initial ? "✏️ 大会を編集" : "📋 大会を作成"}</h3>
      <div style={{ fontSize:12, color:C.textSec, fontWeight:700, marginBottom:6 }}>大会名</div>
      <input style={{ ...S.inp, marginBottom:14 }} placeholder="例：令和8年度 新人戦" value={name} onChange={e=>setName(e.target.value)}/>
      <div style={{ fontSize:12, color:C.textSec, fontWeight:700, marginBottom:6 }}>開催期間</div>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
        <input type="date" style={{ ...S.inp, flex:1 }} value={startDate} onChange={e=>setStartDate(e.target.value)}/>
        <span style={{ fontSize:12, color:C.textSec }}>〜</span>
        <input type="date" style={{ ...S.inp, flex:1 }} value={endDate} onChange={e=>setEndDate(e.target.value)}/>
      </div>
      <div style={{ fontSize:11, color:C.textSec, marginBottom:16 }}>※単日開催の場合は同じ日付を選択してください</div>
      <div style={{ fontSize:12, color:C.textSec, fontWeight:700, marginBottom:6 }}>場所 / 会場名（任意）</div>
      <div style={{ marginBottom:16 }}>
        <VenueField value={venue} onChange={setVenue} venues={venues} placeholder="例：○○市民コート"/>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ flex:1, padding:11, borderRadius:10, border:"none", background:"#f0f2f6", color:C.textSec, fontSize:14, fontWeight:800, cursor:"pointer" }} onClick={onCancel}>キャンセル</button>
        <button
          style={{ flex:1, padding:11, borderRadius:10, border:"none", background:`linear-gradient(135deg,${C.accent},#00a066)`, color:C.white, fontSize:14, fontWeight:800, cursor:saving?"default":"pointer" }}
          disabled={saving}
          onClick={async ()=>{ setSaving(true); await onSave(name, startDate, endDate, venue); setSaving(false); }}
        >{initial ? "保存する" : "作成する"}</button>
      </div>
    </div>
  );
}
// ============================================================
// 大会 詳細画面（大会に紐づく試合一覧）
// ============================================================
function TournamentDetail({ tournament, onBack, onSaved, onOpenMatch, onOpenTeamMatch, onNewIndividual, onNewTeam, onCopyMatch, onCopyTeamMatch, initialSeg, onSegChange, onOpenDrawSetup, onOpenDailyRanking }) {
  const [seg, setSegRaw] = useState(initialSeg || "team"); // team | individual
  const setSeg = (v) => { setSegRaw(v); onSegChange && onSegChange(v); };
  const [matches, setMatches] = useState([]);
  const [teamMatches, setTeamMatches] = useState([]);
  const [schoolMap, setSchoolMap] = useState({});
  const [mySchoolName, setMySchoolName] = useState("");
  const [loading, setLoading] = useState(true);
  const [showEditModal, setShowEditModal] = useState(false);
  const [confirmDeleteMatch, setConfirmDeleteMatch] = useState(null);
  const [confirmDeleteTeamMatch, setConfirmDeleteTeamMatch] = useState(null);
  const [drawSummary, setDrawSummary] = useState({ team: 0, individual: 0 });
  const [drawViewMode, setDrawViewMode] = useState("draw"); // draw | list（ドロー表 or 試合一覧の切り替え）

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([getMatches(), getTeamMatches(), getSchools(), getMyProfile()]).then(([list, tList, schools, profile]) => {
      const smap = {};
      (schools || []).forEach(s => { smap[s.id] = s.name; });
      setSchoolMap(smap);
      if (profile?.school_id) {
        const s = schools.find(s => s.id === profile.school_id);
        if (s) setMySchoolName(s.name);
      }
      setMatches(list.filter(m => m.tournament_name === tournament.name));
      setTeamMatches(tList.filter(tm => tm.tournament_name === tournament.name));
      setLoading(false);
    });
    Promise.all([getDrawSummary(tournament.id, "team"), getDrawSummary(tournament.id, "individual")]).then(([teamCount, indivCount]) => {
      setDrawSummary({ team: teamCount, individual: indivCount });
    });
  }, [tournament.name, tournament.id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display:"flex", alignItems:"center", gap:10 }}>
        <button style={{ background:"none", border:"none", color:C.white, fontSize:20, cursor:"pointer" }} onClick={onBack}>←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:16, fontWeight:800, color:C.white, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{tournament.name}</div>
          <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", marginTop:2 }}>📅 {fmtDateRange(tournament.start_date, tournament.end_date)}</div>
        </div>
        <button style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:12, padding:"6px 10px", cursor:"pointer", whiteSpace:"nowrap" }} onClick={()=>setShowEditModal(true)}>✏️ 編集</button>
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:8, margin:"10px 14px 0" }}>
        <div style={{ display:"flex", background:"#f0f2f6", padding:3, borderRadius:10, flex:1 }}>
          {[["team","🏆 団体戦"],["individual","🎾 個人戦"]].map(([v,l])=>(
            <button key={v} style={{ flex:1, padding:9, border:"none", cursor:"pointer", borderRadius:8, fontSize:13, fontWeight:700, background:seg===v?C.white:"transparent", color:seg===v?C.navy:C.textSec, boxShadow:seg===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>setSeg(v)}>{l}</button>
          ))}
        </div>
        <button
          style={{ background:"none", border:"none", color:C.navy, fontSize:12, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", textDecoration:"underline" }}
          onClick={()=>onOpenDrawSetup && onOpenDrawSetup(seg)}
        >🗂️ ドロー設定</button>
      </div>

      <div style={{ margin:"10px 14px 0" }}>
        <button
          style={{ ...S.btn(C.navy), fontSize:12, padding:"9px", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}
          onClick={()=>onOpenDailyRanking && onOpenDailyRanking(tournament)}
        >📊 日別選手ランキングを見る</button>
      </div>

      <div style={{ padding:"10px 14px", paddingBottom:90 }}>
        {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}

        {!loading && drawSummary[seg] > 0 && (
          <>
            <div style={{ display:"flex", background:C.white, borderRadius:10, border:"1px solid "+C.border, overflow:"hidden", marginBottom:12 }}>
              <button
                style={{ flex:1, padding:"10px 0", border:"none", background: drawViewMode==="draw" ? C.accentL : "none", color: drawViewMode==="draw" ? C.navy : C.textSec, fontSize:13, fontWeight:700, cursor:"pointer" }}
                onClick={()=>setDrawViewMode("draw")}
              >🗂 ドロー表</button>
              <button
                style={{ flex:1, padding:"10px 0", border:"none", background: drawViewMode==="list" ? C.accentL : "none", color: drawViewMode==="list" ? C.navy : C.textSec, fontSize:13, fontWeight:700, cursor:"pointer" }}
                onClick={()=>setDrawViewMode("list")}
              >📋 試合一覧</button>
            </div>
            {drawViewMode==="draw" && (
              <div style={{ marginBottom: 12 }}>
                <DrawBracket
                  tournament={tournament}
                  category={seg}
                  mySchoolName={mySchoolName}
                  onOpenMatch={(id)=>{ if (seg==="individual") onOpenMatch(id); else onOpenTeamMatch(id); }}
                  onCopyMatch={seg==="individual" ? onCopyMatch : undefined}
                />
              </div>
            )}
          </>
        )}

        {!loading && seg==="team" && (drawSummary[seg]===0 || drawViewMode==="list") && teamMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🏆</div>この大会の団体戦記録がありません</div>}
        {!loading && seg==="team" && (drawSummary[seg]===0 || drawViewMode==="list") && teamMatches.map(tm => {
          const myFullLabel = [(tm.my_school_id ? schoolMap[tm.my_school_id] : null) || mySchoolName || "自チーム", tm.my_team_division].filter(Boolean).join("");
          const oppLabel = [tm.opponent_name, tm.opponent_division].filter(Boolean).join("");
          const statusColor = tm.status === "finished" ? (tm.my_score > tm.opponent_score ? C.teamA : C.teamB) : tm.status === "active" ? C.orange : C.accent;
          const statusLabel = tm.status === "finished" ? (tm.my_score > tm.opponent_score ? "勝利" : tm.my_score < tm.opponent_score ? "敗北" : "全試合終了") : tm.status === "active" ? "⏳ 進行中" : "📅 予定";
          return (
            <div key={tm.id} style={{ ...S.card, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:10 }}>
              <div style={{ height:4, background:statusColor }}/>
              <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpenTeamMatch(tm.id)}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:12, fontWeight:700 }}>{tm.round || "団体戦"}</span>
                  <span style={{ fontSize:11, color:C.textSec }}>{fmtDate(tm.match_date)}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1, textAlign:"right" }}>{myFullLabel}</span>
                  <span style={{ fontSize:20, fontWeight:900, color:statusColor, minWidth:48, textAlign:"center" }}>{tm.my_score??0}-{tm.opponent_score??0}</span>
                  <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1 }}>{oppLabel || "相手"}</span>
                </div>
                <span style={{ fontSize:11, padding:"2px 10px", borderRadius:20, background:statusColor+"22", color:statusColor, fontWeight:700 }}>{statusLabel}</span>
                <span style={{ fontSize:10, color:C.textSec, marginLeft:8 }}>{tm.is_younger===false ? "遅番" : tm.is_younger===true ? "若番" : "若番/遅番未設定"}</span>
              </div>
              <div style={{ display:"flex", borderTop:"1px solid "+C.border }}>
                <button style={{ flex:1, padding:"8px", background:"#f5f5f5", color:C.navy, border:"none", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={()=>onCopyTeamMatch(tm.id)}>📋 コピーして新規作成</button>
                <button style={{ width:60, padding:"8px", background:"#fdecea", color:C.red, border:"none", borderLeft:"1px solid "+C.border, fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={()=>setConfirmDeleteTeamMatch(tm.id)}>🗑</button>
              </div>
            </div>
          );
        })}

        {!loading && seg==="individual" && (drawSummary[seg]===0 || drawViewMode==="list") && matches.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🎾</div>この大会の個人戦記録がありません</div>}
        {!loading && seg==="individual" && (drawSummary[seg]===0 || drawViewMode==="list") && matches.map(m => {
          const aWin = m.status==="finished" && m.match_score_a > m.match_score_b;
          const bWin = m.status==="finished" && m.match_score_b > m.match_score_a;
          const aPlayers = m.players.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num);
          const bPlayers = m.players.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num);
          const aNames = aPlayers.map(p=>p.player_name).join("/");
          const bNames = bPlayers.map(p=>p.player_name).join("/");
          const aClub = aPlayers[0]?.club_name || "";
          const bClub = bPlayers[0]?.club_name || "";
          const borderColor = m.status==="active" ? C.orange : m.status==="waiting" ? C.purple : m.status==="scheduled" ? C.accent : m.status==="abandoned" ? C.textSec : m.status==="suspended" ? C.textSec : aWin ? C.teamA : bWin ? C.teamB : C.border;
          return (
            <div key={m.id} style={{ ...S.card, marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
              <div style={{ height:4, background:borderColor }}/>
              <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpenMatch(m.id)}>
                <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>{fmtDate(m.match_date)}{m.round ? ` · ${m.round}` : ""}</div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:aWin?800:600, color:aWin?C.teamA:C.text }}>{aClub && <span style={{ fontSize:11, color:C.textSec, marginRight:6 }}>{aClub}</span>}{aNames}</div>
                    <div style={{ fontSize:13, fontWeight:bWin?800:600, color:bWin?C.teamB:C.text, marginTop:2 }}>{bClub && <span style={{ fontSize:11, color:C.textSec, marginRight:6 }}>{bClub}</span>}{bNames}</div>
                  </div>
                  {m.status!=="scheduled" && m.status!=="waiting" && <div style={{ fontSize:22, fontWeight:900, color:aWin?C.teamA:bWin?C.teamB:C.textSec, minWidth:48, textAlign:"right" }}>{m.match_score_a}-{m.match_score_b}</div>}
                </div>
              </div>
              <div style={{ display:"flex", borderTop:"1px solid "+C.border }}>
                <button style={{ flex:1, padding:"8px", background:"#f5f5f5", color:C.navy, border:"none", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={()=>onCopyMatch(m.id)}>📋 コピーして新規作成</button>
                <button style={{ width:60, padding:"8px", background:"#fdecea", color:C.red, border:"none", borderLeft:"1px solid "+C.border, fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={()=>setConfirmDeleteMatch(m.id)}>🗑</button>
              </div>
            </div>
          );
        })}

        {!loading && <div style={{ textAlign:"center", fontSize:11, color:C.textSec, marginTop:16 }}>＋ボタンから、この大会に紐づく試合を作成できます</div>}
      </div>

      <button
        style={{ position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",background:seg==="team"?`linear-gradient(135deg,${C.navy},${C.navyMid})`:`linear-gradient(135deg,${C.accent},#00a066)`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,0,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center" }}
        onClick={()=>seg==="team" ? onNewTeam() : onNewIndividual()}
      >＋</button>

      {showEditModal && (
        <Modal onClose={()=>setShowEditModal(false)}>
          <TournamentFormFields
            initial={tournament}
            onCancel={()=>setShowEditModal(false)}
            onSave={async (name, startDate, endDate, venue)=>{
              const trimmed = name.trim();
              if (!trimmed) { alert("大会名を入力してください"); return; }
              if (!startDate) { alert("開始日を選択してください"); return; }
              try {
                const saved = await saveTournament({ id: tournament.id, name: trimmed, start_date: startDate, end_date: endDate || startDate, venue: venue || null });
                // ★大会名が変わった場合、既存の個人戦・団体戦の大会名も追従させる（見えない文字ズレによる紐付け解除を防ぐ）
                if (tournament.name && tournament.name.trim() !== trimmed) {
                  await renameTournamentCascade(tournament.name, trimmed);
                }
                setShowEditModal(false);
                onSaved && onSaved(saved);
              } catch(e) {
                alert("保存エラー: " + (e.message || e));
              }
            }}
          />
        </Modal>
      )}

      {confirmDeleteMatch && (
        <Modal onClose={()=>setConfirmDeleteMatch(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この試合を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>ゴミ箱に移動します。24時間以内であれば元に戻せます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDeleteMatch(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={async()=>{ const link = await getDrawMatchByMatchId(confirmDeleteMatch); await deleteMatch(confirmDeleteMatch); if (link) await clearDrawMatchLink(link.id); setConfirmDeleteMatch(null); reload(); }}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
      {confirmDeleteTeamMatch && (
        <Modal onClose={()=>setConfirmDeleteTeamMatch(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40,marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16,fontWeight:800,marginBottom:8 }}>この団体戦を削除しますか？</h3>
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>ゴミ箱に移動します。24時間以内であれば元に戻せます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDeleteTeamMatch(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={async()=>{ await deleteTeamMatch(confirmDeleteTeamMatch); setConfirmDeleteTeamMatch(null); reload(); }}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// 日別 選手ランキング（大会×日付を指定し、その日に出場した自チーム選手を
// 「勝敗／1stサーブ率／レシーブミス／得点／ミス／得失点差」でランキング表示）
// ============================================================
function DailyPlayerRankingScreen({ tournament, onBack }) {
  const [loading, setLoading] = useState(true);
  const [dateGroups, setDateGroups] = useState({}); // { "YYYY-MM-DD": [match, match, ...] }
  const [selectedDate, setSelectedDate] = useState(null);
  const [expandedMetric, setExpandedMetric] = useState(null); // 「11位以降を見る」で開く項目キー

  const [loadError, setLoadError] = useState(null);
  const [roundBreakdown, setRoundBreakdown] = useState([]); // ★診断用：団体戦(ラウンド)ごとのteam_match_games内訳
  const [dedupDiag, setDedupDiag] = useState(null); // ★診断用：重複除去(dedup)前後の件数

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const [matchSummaries, teamMatches] = await Promise.all([getMatches(), getTeamMatches()]);

        // ★診断用：この大会に属する団体戦(ラウンド)ごとに、番手が何件あり、
        //   うちmatch_idが入っている(＝集計対象になる)のは何件かを可視化する
        const breakdown = teamMatches
          .filter(tm => tm.tournament_name === tournament.name)
          .map(tm => {
            const games = tm.games || [];
            return {
              id: tm.id,
              round: tm.round || "(ラウンド名なし)",
              date: tm.match_date,
              status: tm.status,
              format: tm.format,
              totalGames: games.length,
              withMatchId: games.filter(g => g.match_id).length,
              games: games.map(g => ({ order_num:g.order_num, has_match_id: !!g.match_id, status: g.status })),
            };
          });
        setRoundBreakdown(breakdown);

        const teamBoutIds = new Set();
        teamMatches.forEach(tm => (tm.games||[]).forEach(g => { if (g.match_id) teamBoutIds.add(g.match_id); }));

        // ★対象となる試合ID＋その日付（個人戦はmatch_date、団体戦の各番手は団体戦本体のmatch_dateを使う）
        const targetRows = [];
        matchSummaries
          .filter(m => m.tournament_name === tournament.name && !teamBoutIds.has(m.id))
          .forEach(m => targetRows.push({ matchId: m.id, date: m.match_date }));
        teamMatches
          .filter(tm => tm.tournament_name === tournament.name)
          .forEach(tm => (tm.games||[]).forEach(g => {
            if (g.match_id) targetRows.push({ matchId: g.match_id, date: tm.match_date });
          }));
        const uniqueRows = Array.from(new Map(targetRows.map(row => [row.matchId, row])).values());

        // ★診断用：targetRows→uniqueRowsで件数が減っていれば、
        //   複数の番手が同じmatch_idを参照している（重複除去で消えている）ことになる
        const dedupDiag = {
          targetRowsCount: targetRows.length,
          uniqueRowsCount: uniqueRows.length,
          duplicateMatchIds: (() => {
            const counts = {};
            targetRows.forEach(r => { counts[r.matchId] = (counts[r.matchId]||0) + 1; });
            return Object.entries(counts).filter(([,c]) => c > 1).map(([id,c]) => ({ id, count:c }));
          })(),
        };

        // ★集計に必要なplayer_name/play_type/faultsなどを含む「詳細データ」を1件ずつ取得する
        //   （getMatches()の一覧データはポイントの一部項目のみで、選手別集計には使えないため）
        const detailedMatches = await Promise.all(
          uniqueRows.map(async row => {
            const full = await getMatch(row.matchId);
            return full ? { ...full, ranking_date: row.date || full.match_date } : null;
          })
        );
        dedupDiag.detailedMatchesCount = detailedMatches.length;
        dedupDiag.nullDetailCount = detailedMatches.filter(x => !x).length;
        setDedupDiag(dedupDiag);

        const groups = {};
        detailedMatches.filter(Boolean).forEach(m => {
          const date = m.ranking_date;
          if (!date) return;
          (groups[date] ??= []).push(m);
        });

        if (cancelled) return;
        setDateGroups(groups);
        const dates = Object.keys(groups).sort();
        setSelectedDate(prev => (prev && groups[prev]) ? prev : (dates[0] ?? null));
      } catch (e) {
        if (!cancelled) setLoadError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [tournament.name]);

  // ★大会の開催期間（start_date〜end_date）に入っていない日付は、
  //   同じ大会名で誤って別日に記録されたデータの可能性が高いため除外する
  const tStart = tournament.start_date;
  const tEnd = tournament.end_date || tournament.start_date;
  const availableDates = Object.keys(dateGroups)
    .filter(d => (!tStart || d >= tStart) && (!tEnd || d <= tEnd))
    .sort();
  const matchesOfDay = selectedDate ? (dateGroups[selectedDate] || []) : [];

  // ★選択中の日の自チーム(A)選手ごとの集計
  // 「前衛」「後衛」は本来ポジション名であり、選手名として誤登録された場合に紛れ込むため除外する
  const PLACEHOLDER_NAMES = new Set(["前衛", "後衛"]);
  let players = [];
  let computeError = null;
  try {
    const playerAgg = {};
    const ensure = (name) => (playerAgg[name] ??= { name, matches:0, wins:0, losses:0, winners:0, errors:0, serveTotal:0, serveFault:0, receiveTotal:0, receiveMiss:0 });
    matchesOfDay.forEach(m => {
      const stats = calcPlayerStats(m).filter(s => s.team === "A" && !PLACEHOLDER_NAMES.has(s.player_name));
      const isWin = m.match_score_a > m.match_score_b;
      const isFinished = m.status === "finished";
      const seenThisMatch = new Set();
      stats.forEach(s => {
        const r = ensure(s.player_name);
        r.winners += s.winners; r.errors += s.errors;
        r.serveTotal += s.serveTotal; r.serveFault += s.serveFault;
        r.receiveTotal += s.receiveTotal; r.receiveMiss += s.receiveMiss;
        seenThisMatch.add(s.player_name);
      });
      // ★「結果だけ記録」の試合はポイントデータが無くcalcPlayerStatsに出てこないため、
      //   match_players（実際に出場したA側の選手）から直接、勝敗の対象に含める
      (Array.isArray(m.players) ? m.players : []).forEach(p => {
        if (p.team === "A" && p.player_name && !PLACEHOLDER_NAMES.has(p.player_name)) seenThisMatch.add(p.player_name);
      });
      if (isFinished) {
        seenThisMatch.forEach(name => {
          const r = ensure(name);
          r.matches++;
          if (isWin) r.wins++; else r.losses++;
        });
      }
    });
    players = Object.values(playerAgg);
  } catch (e) {
    computeError = e;
  }

  if (computeError) {
    return (
      <div style={S.page}>
        <div style={{ ...S.hdr, display:"flex", alignItems:"center", gap:10 }}>
          <button style={{ background:"none", border:"none", color:C.white, fontSize:20, cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:16, fontWeight:800, color:C.white }}>日別 選手ランキング</span>
        </div>
        <div style={{ padding:20 }}>
          <div style={{ fontSize:13, fontWeight:800, color:C.red, marginBottom:8 }}>集計中にエラーが発生しました</div>
          <div style={{ fontSize:12, color:C.textSec, whiteSpace:"pre-wrap" }}>{computeError.message || String(computeError)}</div>
        </div>
      </div>
    );
  }

  const metrics = [
    { key:"winloss", icon:"🏆", title:"勝敗",
      list: players.filter(p=>p.matches>0).map(p=>({ name:p.name, sub:`${p.matches}試合`, val:`${p.wins}勝${p.losses}敗`, sortVal:p.wins*1000-p.losses })).sort((a,b)=>b.sortVal-a.sortVal) },
    { key:"firstserve", icon:"🎾", title:"1stサーブ率",
      list: players.filter(p=>p.serveTotal>0).map(p=>({ name:p.name, sub:`${p.serveTotal-p.serveFault}/${p.serveTotal}本`, val:`${Math.round((p.serveTotal-p.serveFault)/p.serveTotal*100)}%`, sortVal:(p.serveTotal-p.serveFault)/p.serveTotal })).sort((a,b)=>b.sortVal-a.sortVal) },
    { key:"receivemiss", icon:"🛡", title:"レシーブミスが少ない順",
      list: players.filter(p=>p.receiveTotal>0).map(p=>({ name:p.name, sub:null, val:`${p.receiveMiss}回`, sortVal:-p.receiveMiss })).sort((a,b)=>b.sortVal-a.sortVal) },
    { key:"winners", icon:"💪", title:"得点（決めた）が多い順",
      list: players.map(p=>({ name:p.name, sub:null, val:`${p.winners}点`, sortVal:p.winners })).sort((a,b)=>b.sortVal-a.sortVal) },
    { key:"errors", icon:"📝", title:"ミスが少ない順",
      list: players.map(p=>({ name:p.name, sub:null, val:`${p.errors}回`, sortVal:-p.errors })).sort((a,b)=>b.sortVal-a.sortVal) },
    { key:"diff", icon:"📊", title:"得失点差が大きい順",
      list: players.map(p=>({ name:p.name, sub:null, val:(p.winners-p.errors)>=0?`+${p.winners-p.errors}`:`${p.winners-p.errors}`, sortVal:p.winners-p.errors })).sort((a,b)=>b.sortVal-a.sortVal) },
  ];

  if (expandedMetric) {
    const m = metrics.find(mm => mm.key === expandedMetric);
    return (
      <div style={S.page}>
        <div style={{ ...S.hdr, display:"flex", alignItems:"center", gap:10 }}>
          <button style={{ background:"none", border:"none", color:C.white, fontSize:20, cursor:"pointer" }} onClick={()=>setExpandedMetric(null)}>←</button>
          <span style={{ fontSize:16, fontWeight:800, color:C.white }}>{m.icon} {m.title}</span>
        </div>
        <div style={{ padding:14, paddingBottom:90 }}>
          <div style={S.card}>
            {m.list.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>データがありません</div>}
            {m.list.map((row,i)=>(
              <div key={row.name} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px", borderBottom: i<m.list.length-1?`1px solid ${C.border}`:"none" }}>
                <div style={{ width:24, textAlign:"center", fontSize:13, fontWeight:800, color:i<3?C.navy:C.textSec }}>{i+1}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13.5, fontWeight:700 }}>{row.name}</div>
                  {row.sub && <div style={{ fontSize:10.5, color:C.textSec, marginTop:1 }}>{row.sub}</div>}
                </div>
                <div style={{ fontSize:15, fontWeight:800, color:C.navy }}>{row.val}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display:"flex", alignItems:"center", gap:10 }}>
        <button style={{ background:"none", border:"none", color:C.white, fontSize:20, cursor:"pointer" }} onClick={onBack}>←</button>
        <div>
          <div style={{ fontSize:16, fontWeight:800, color:C.white }}>日別 選手ランキング</div>
          <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", marginTop:2 }}>{tournament.name}</div>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading ? (
          <div style={{ textAlign:"center", color:C.textSec, marginTop:60 }}>読み込み中...</div>
        ) : loadError ? (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:C.red, marginBottom:8 }}>読み込み中にエラーが発生しました</div>
            <div style={{ fontSize:12, color:C.textSec, whiteSpace:"pre-wrap" }}>{loadError.message || String(loadError)}</div>
          </div>
        ) : availableDates.length===0 ? (
          <div style={{ textAlign:"center", color:C.textSec, marginTop:60 }}>この大会にはまだ試合記録がありません</div>
        ) : (
          <>
            <div style={{ ...S.card, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:11, color:C.textSec, marginBottom:8, fontWeight:700 }}>日付を選択</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {availableDates.map(d=>(
                  <button key={d} style={{ ...S.togBtn(selectedDate===d, C.navy), fontSize:12, padding:"7px 12px" }} onClick={()=>setSelectedDate(d)}>{fmtDate(d)}</button>
                ))}
              </div>
              <div style={{ fontSize:11, color:C.textSec, marginTop:8 }}>{matchesOfDay.length}試合</div>
            </div>

            {/* ★診断用：重複除去(dedup)で件数が減っていないか確認する */}
            {dedupDiag && (
              <div style={{ ...S.card, padding:14, marginBottom:14, border:`1px solid ${C.red}` }}>
                <div style={{ fontSize:12, fontWeight:800, marginBottom:8, color:C.red }}>🔍 重複除去の診断</div>
                <div style={{ fontSize:12, color:C.text }}>集計対象の候補（重複除去前）：{dedupDiag.targetRowsCount}件</div>
                <div style={{ fontSize:12, color:C.text }}>重複除去後（match_idユニーク）：{dedupDiag.uniqueRowsCount}件</div>
                <div style={{ fontSize:12, color:C.text }}>詳細データ取得件数：{dedupDiag.detailedMatchesCount}件（うち取得失敗：{dedupDiag.nullDetailCount}件）</div>
                {dedupDiag.duplicateMatchIds.length > 0 ? (
                  <div style={{ marginTop:8 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:C.red }}>⚠️ 同じmatch_idが複数の番手から参照されています：</div>
                    {dedupDiag.duplicateMatchIds.map(d=>(
                      <div key={d.id} style={{ fontSize:11, color:C.textSec, marginTop:2 }}>match_id: {d.id.slice(0,8)}...　参照数: {d.count}件</div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize:12, color:C.textSec, marginTop:8 }}>match_idの重複はありません（原因は別にあります）</div>
                )}
              </div>
            )}

            {/* ★診断用：この大会の団体戦(ラウンド)ごとに、番手が何件登録され、
                  うち何件がmatch_id付き(＝集計対象)になっているかを確認できるようにする */}
            {roundBreakdown.length > 0 && (
              <div style={{ ...S.card, padding:14, marginBottom:14 }}>
                <div style={{ fontSize:12, fontWeight:800, marginBottom:10 }}>🔍 団体戦の内訳（診断用）</div>
                {roundBreakdown.map(rb=>(
                  <div key={rb.id} style={{ padding:"8px 0", borderBottom:`1px solid ${C.border}`, fontSize:11.5 }}>
                    <div style={{ fontWeight:700 }}>{rb.round}　{fmtDate(rb.date)}　({rb.format || "format不明"} / {rb.status})</div>
                    <div style={{ color:C.textSec, marginTop:2 }}>
                      番手：{rb.totalGames}件中 {rb.withMatchId}件にmatch_idあり
                      {rb.totalGames !== rb.withMatchId && <span style={{ color:C.red, fontWeight:700 }}>　← {rb.totalGames - rb.withMatchId}件が集計対象外</span>}
                    </div>
                    <div style={{ color:C.textSec, marginTop:2 }}>
                      {rb.games.map(g=>`${g.order_num}番手:${g.has_match_id?"○":"✕(match_idなし)"}(${g.status})`).join("　")}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ★どの試合が集計対象になっているか確認できるよう、一覧をそのまま表示する（人数が合わない時の確認用） */}
            <div style={{ ...S.card, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:12, fontWeight:800, marginBottom:10 }}>📋 この日に集計対象となった試合（{matchesOfDay.length}件）</div>
              {matchesOfDay.length===0 ? (
                <div style={{ fontSize:12, color:C.textSec, textAlign:"center" }}>試合がありません</div>
              ) : matchesOfDay.map((m,i)=>{
                const aP = (m.players||[]).filter(p=>p.team==="A").map(p=>p.player_name).join("/") || "(選手未登録)";
                const bP = (m.players||[]).filter(p=>p.team==="B").map(p=>p.player_name).join("/") || "(選手未登録)";
                return (
                  <div key={m.id||i} style={{ padding:"7px 0", borderBottom: i<matchesOfDay.length-1?`1px solid ${C.border}`:"none", fontSize:11.5 }}>
                    <div style={{ color:C.text }}>{aP} <span style={{ color:C.textSec }}>vs</span> {bP}</div>
                    <div style={{ color:C.textSec, marginTop:1 }}>
                      {m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : `状態:${m.status}`}
                      {m.games?.length===0 && m.status==="finished" ? "（結果だけ記録）" : ""}
                    </div>
                  </div>
                );
              })}
            </div>

            {metrics.map(m=>(
              <div key={m.key} style={{ ...S.card, padding:14, marginBottom:12 }}>
                <div style={{ fontSize:13, fontWeight:800, marginBottom:10 }}>{m.icon} {m.title}</div>
                {m.list.length===0 ? (
                  <div style={{ textAlign:"center", color:C.textSec, fontSize:12, padding:"10px 0" }}>データがありません</div>
                ) : (
                  <>
                    {m.list.slice(0,10).map((row,i)=>(
                      <div key={row.name} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom: i<Math.min(m.list.length,10)-1?`1px solid ${C.border}`:"none" }}>
                        <div style={{ width:20, textAlign:"center", fontSize:12, fontWeight:800, color:i<3?C.navy:C.textSec }}>{i+1}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:13, fontWeight:700 }}>{row.name}</div>
                          {row.sub && <div style={{ fontSize:10, color:C.textSec, marginTop:1 }}>{row.sub}</div>}
                        </div>
                        <div style={{ fontSize:14, fontWeight:800, color:C.navy }}>{row.val}</div>
                      </div>
                    ))}
                    {m.list.length > 10 && (
                      <button
                        style={{ width:"100%", textAlign:"center", padding:9, marginTop:8, borderRadius:9, background:C.gray, border:`1px solid ${C.border}`, fontSize:12, fontWeight:700, color:C.navy, cursor:"pointer" }}
                        onClick={()=>setExpandedMetric(m.key)}
                      >11位以降を見る（全{m.list.length}人）→</button>
                    )}
                  </>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <NavBar active="" onNavigate={()=>{}} />
    </div>
  );
}


// ============================================================
// ドロー作成画面（回戦数・試合数の入力 → draw_matches を差分作成）
// ============================================================
function chipStyle(active) {
  return {
    flex: "none", padding: "7px 16px", borderRadius: 999, border: "1px solid " + (active ? C.navy : C.border),
    background: active ? C.navy : C.white, color: active ? C.white : C.textSec,
    fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer",
  };
}

function DrawSetup({ tournament, category, onBack }) {
  const [catMode, setCatMode] = useState(category || "individual");
  const [blockLabels, setBlockLabels] = useState([]); // ['A','B',...]（DB上に既にあるもの＋今回分けたもの）
  const [currentScope, setCurrentScope] = useState("ALL"); // "ALL"(ブロックなし) | "A" | "B" ...
  const [loadedScopes, setLoadedScopes] = useState({}); // { ALL:true, A:true, ... } 一度読み込んだスコープ（編集中の内容を保持するため再読込しない）
  const [scopeMatchCounts, setScopeMatchCounts] = useState({ ALL: ["8", "4", "2", "1"] }); // scope -> string[]
  const [scopeDirty, setScopeDirty] = useState({ ALL: [false, false, false, false] }); // scope -> bool[]（true=ユーザーが直接手入力した回戦。回戦数変更時も保護する）
  const [scopeRoundInput, setScopeRoundInput] = useState({ ALL: "4" }); // scope -> "4" など
  const [roundCountError, setRoundCountError] = useState(false);
  const [blockCountInput, setBlockCountInput] = useState("");
  const [blockCountError, setBlockCountError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [skippedInfo, setSkippedInfo] = useState(null); // { [scope]: [{round,desired,current,emptyAvailable}] }

  const matchCounts = scopeMatchCounts[currentScope] || [];
  const roundCountInput = scopeRoundInput[currentScope] || "";

  const defaultMatchesForCount = (n) => {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(Math.pow(2, n - 1 - i));
    return arr;
  };
  const toNum = (s, fallback = 1) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const toDbLabel = (scope) => (scope === "ALL" ? null : scope);

  const fetchScopeData = useCallback(async (cat, scope) => {
    const rows = await getDrawMatches(tournament.id, cat, toDbLabel(scope));
    if (rows.length === 0) {
      return { roundInput: "4", matchCounts: defaultMatchesForCount(4).map(String) };
    }
    const maxRound = Math.max(...rows.map(r => r.round_no));
    const counts = [];
    for (let i = 1; i <= maxRound; i++) counts.push(rows.filter(r => r.round_no === i).length);
    return { roundInput: String(maxRound), matchCounts: counts.map(String) };
  }, [tournament.id]);

  // 種別（団体戦/個人戦）を切り替えたら全部リセットして「すべて」から読み込み直す
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const labels = await getDrawBlockLabels(tournament.id, catMode);
      if (!alive) return;
      const allData = await fetchScopeData(catMode, "ALL");
      if (!alive) return;
      setBlockLabels(labels);
      setCurrentScope("ALL");
      setLoadedScopes({ ALL: true });
      setScopeMatchCounts({ ALL: allData.matchCounts });
      setScopeDirty({ ALL: allData.matchCounts.map(() => false) });
      setScopeRoundInput({ ALL: allData.roundInput });
      setSkippedInfo(null);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [catMode, tournament.id, fetchScopeData]);

  // スコープ切替：すでに読み込み済み（＝今回のセッションで編集中）のスコープはDBから読み直さない。
  // これにより、Aブロックを編集してBブロックを見てまたAに戻っても、Aの入力内容は消えない。
  const switchScope = async (scope) => {
    setCurrentScope(scope);
    if (loadedScopes[scope]) return;
    setLoading(true);
    const data = await fetchScopeData(catMode, scope);
    setScopeMatchCounts(prev => ({ ...prev, [scope]: data.matchCounts }));
    setScopeDirty(prev => ({ ...prev, [scope]: data.matchCounts.map(() => false) }));
    setScopeRoundInput(prev => ({ ...prev, [scope]: data.roundInput }));
    setLoadedScopes(prev => ({ ...prev, [scope]: true }));
    setLoading(false);
  };

  // 回戦数を変更したら、ユーザーが直接手入力した回戦（dirty）だけは値を保持し、
  // それ以外は「決勝=1、その前=2、以降は手前ほど倍」の正しい進行になるよう毎回計算し直す。
  // （手入力していない値をそのまま残すと、回戦数を変えたときに矛盾した試合数になってしまうため）
  const onRoundCountChange = (v) => {
    setScopeRoundInput(prev => ({ ...prev, [currentScope]: v }));
    if (v === "" || !/^[0-9]+$/.test(v) || parseInt(v, 10) < 1) {
      setRoundCountError(true);
      return;
    }
    setRoundCountError(false);
    const n = parseInt(v, 10);
    const freshDefaults = defaultMatchesForCount(n).map(String);
    setScopeMatchCounts(prev => {
      const cur = prev[currentScope] || [];
      const curDirty = scopeDirty[currentScope] || [];
      const next = [];
      for (let i = 0; i < n; i++) {
        next.push(i < cur.length && curDirty[i] ? cur[i] : freshDefaults[i]);
      }
      return { ...prev, [currentScope]: next };
    });
    setScopeDirty(prev => {
      const curDirty = prev[currentScope] || [];
      const next = [];
      for (let i = 0; i < n; i++) next.push(i < curDirty.length ? curDirty[i] : false);
      return { ...prev, [currentScope]: next };
    });
  };

  // 各回戦の試合数入力（この行・このスコープだけを更新。他には一切触れない。
  // 手入力した回戦は dirty としてマークし、以後の回戦数変更で自動上書きされないようにする）
  const onMatchCountChange = (idx, v) => {
    if (v !== "" && !/^[0-9]+$/.test(v)) return;
    setScopeMatchCounts(prev => {
      const cur = [...(prev[currentScope] || [])];
      cur[idx] = v;
      return { ...prev, [currentScope]: cur };
    });
    setScopeDirty(prev => {
      const cur = [...(prev[currentScope] || [])];
      cur[idx] = true;
      return { ...prev, [currentScope]: cur };
    });
  };

  // 「すべて」の内容をブロック数で均等割りし、まだ無いブロックだけ新規に用意する
  const applyBlockSplit = () => {
    if (blockCountInput === "" || !/^[0-9]+$/.test(blockCountInput) || parseInt(blockCountInput, 10) < 1) {
      setBlockCountError(true);
      return;
    }
    setBlockCountError(false);
    const n = parseInt(blockCountInput, 10);
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, n);
    const allCounts = scopeMatchCounts.ALL || [];
    const allRoundInput = scopeRoundInput.ALL || "4";

    setScopeMatchCounts(prev => {
      const next = { ...prev };
      letters.forEach(l => {
        if (!loadedScopes[l]) next[l] = allCounts.map(v => String(Math.max(1, Math.floor(toNum(v) / n))));
      });
      return next;
    });
    setScopeDirty(prev => {
      const next = { ...prev };
      letters.forEach(l => {
        if (!loadedScopes[l]) next[l] = allCounts.map(() => false);
      });
      return next;
    });
    setScopeRoundInput(prev => {
      const next = { ...prev };
      letters.forEach(l => { if (!loadedScopes[l]) next[l] = allRoundInput; });
      return next;
    });
    setLoadedScopes(prev => {
      const next = { ...prev };
      letters.forEach(l => { next[l] = true; });
      return next;
    });
    setBlockLabels(prev => Array.from(new Set([...prev, ...letters])).sort());
    setCurrentScope(letters[0]);
  };

  // 既存のブロック分けをすべて片付けて「すべて」からやり直す
  const resetBlocks = async () => {
    if (!window.confirm("既存のブロック分けをリセットして、「すべて」からやり直しますか？（対戦情報が入っている試合があるブロックは削除されません）")) return;
    setLoading(true);
    try {
      const { remaining } = await clearAllBlocksDraw(tournament.id, catMode);
      if (remaining > 0) {
        alert(`対戦情報が入っている試合が${remaining}件残っているため、そのブロックは消せませんでした。空いている枠だけリセットしました。`);
      }
      const labels = await getDrawBlockLabels(tournament.id, catMode);
      const allData = await fetchScopeData(catMode, "ALL");
      setBlockLabels(labels);
      setCurrentScope("ALL");
      setLoadedScopes({ ALL: true });
      setScopeMatchCounts({ ALL: allData.matchCounts });
      setScopeDirty({ ALL: allData.matchCounts.map(() => false) });
      setScopeRoundInput({ ALL: allData.roundInput });
    } catch (e) {
      alert("リセットエラー: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  };

  // 「この内容でドローを作成」：ブロックが1つでもあれば全ブロックをまとめて保存する。
  // ブロック分けが確定した場合は、旧「すべて（ブロックなし）」のドローが残っていれば片付ける。
  const handleCreate = async () => {
    setSaving(true);
    try {
      const scopesToSave = blockLabels.length > 0 ? blockLabels : ["ALL"];

      // 画面上でまだ開いていない（＝読み込んでいない）ブロックがあれば、保存前に必ずDBから読み込む。
      // ここを飛ばすと、未読み込みブロックが「試合数0」として扱われ、削除対象になってしまう。
      const countsByScope = {};
      for (const scope of scopesToSave) {
        if (loadedScopes[scope] && scopeMatchCounts[scope]) {
          countsByScope[scope] = scopeMatchCounts[scope];
        } else {
          const data = await fetchScopeData(catMode, scope);
          countsByScope[scope] = data.matchCounts;
        }
      }

      const skippedByScope = {};
      let total = 0;

      for (const scope of scopesToSave) {
        const counts = (countsByScope[scope] || []).map(v => toNum(v, 1));
        const { skippedRounds } = await saveDrawRounds(tournament.id, catMode, toDbLabel(scope), counts);
        if (skippedRounds.length) skippedByScope[scope] = skippedRounds;
        total += counts.reduce((a, b) => a + b, 0);
      }

      let unblockedRemaining = 0;
      if (blockLabels.length > 0) {
        const { remaining } = await clearUnblockedDraw(tournament.id, catMode);
        unblockedRemaining = remaining;
      }

      // 保存後の状態を読み直す
      const labels = await getDrawBlockLabels(tournament.id, catMode);
      const scopeToShow = labels.length > 0 ? labels[0] : "ALL";
      const data = await fetchScopeData(catMode, scopeToShow);
      setBlockLabels(labels);
      setCurrentScope(scopeToShow);
      setScopeMatchCounts({ [scopeToShow]: data.matchCounts });
      setScopeDirty({ [scopeToShow]: data.matchCounts.map(() => false) });
      setScopeRoundInput({ [scopeToShow]: data.roundInput });
      setLoadedScopes({ [scopeToShow]: true });

      if (Object.keys(skippedByScope).length) {
        setSkippedInfo(skippedByScope);
      } else {
        let msg = `ドローを作成しました（全${total}試合`;
        if (blockLabels.length > 0) msg += `・${blockLabels.length}ブロック`;
        msg += "）";
        if (unblockedRemaining > 0) {
          msg += `\n※「すべて（ブロックなし）」側に対戦情報が入った枠が${unblockedRemaining}件残っているため、そちらは削除していません。`;
        }
        alert(msg);
        if (unblockedRemaining === 0) onBack();
      }
    } catch (e) {
      alert("保存エラー: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display: "flex", alignItems: "center", gap: 10 }}>
        <button style={{ background: "none", border: "none", color: C.white, fontSize: 20, cursor: "pointer" }} onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.white }}>ドロー作成・{catMode === "team" ? "団体戦" : "個人戦"}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tournament.name}</div>
        </div>
      </div>

      <div style={{ display: "flex", background: "#f0f2f6", padding: 3, margin: "14px 14px 0", borderRadius: 10 }}>
        {[["team", "🏆 団体戦"], ["individual", "🎾 個人戦"]].map(([v, l]) => (
          <button key={v} style={{ flex: 1, padding: 9, border: "none", cursor: "pointer", borderRadius: 8, fontSize: 13, fontWeight: 700, background: catMode === v ? C.white : "transparent", color: catMode === v ? C.navy : C.textSec, boxShadow: catMode === v ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }} onClick={() => setCatMode(v)}>{l}</button>
        ))}
      </div>

      {blockLabels.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "10px 14px 4px" }}>
          <button style={chipStyle(currentScope === "ALL")} onClick={() => switchScope("ALL")}>すべて</button>
          {blockLabels.map(l => (
            <button key={l} style={chipStyle(currentScope === l)} onClick={() => switchScope(l)}>{l}ブロック</button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", color: C.textSec, marginTop: 60 }}>読み込み中...</div>
      ) : (
        <div style={{ padding: "6px 14px 100px" }}>
          {blockLabels.length > 0 && (
            <div style={{ fontSize: 11, color: C.textSec, padding: "0 2px 10px" }}>
              「この内容でドローを作成」を押すと、{blockLabels.join("・")}ブロックの内容がまとめて保存されます。
            </div>
          )}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottom: "1px solid " + C.border }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>何回戦までありますか？</div>
                <div style={{ fontSize: 11, color: C.textSec, marginTop: 2 }}>例：決勝まで含めて6回戦</div>
              </div>
              <input
                type="text" inputMode="numeric"
                value={roundCountInput}
                onChange={e => onRoundCountChange(e.target.value)}
                style={{ width: 70, border: "1px solid " + (roundCountError ? C.red : C.border), borderRadius: 9, padding: "9px 10px", fontSize: 15, fontWeight: 800, textAlign: "right" }}
              />
            </div>
            {roundCountError && <div style={{ color: C.red, fontSize: 11.5, fontWeight: 700, padding: "0 14px 10px" }}>半角数字のみ入力してください</div>}

            <div style={{ padding: "12px 14px", background: C.accentL }}>
              <div style={{ fontSize: 11, color: C.navy, fontWeight: 700, marginBottom: 8 }}>
                各回戦の試合数（{currentScope === "ALL" ? "すべて" : currentScope + "ブロック"}・数字を直接入力）
              </div>
              {matchCounts.map((val, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                  <span style={{ fontSize: 12.5 }}>{idx + 1}回戦</span>
                  <input
                    type="text" inputMode="numeric" value={val}
                    onChange={e => onMatchCountChange(idx, e.target.value)}
                    style={{ width: 74, border: "1px solid " + C.border, borderRadius: 8, padding: "7px 9px", fontSize: 13.5, fontWeight: 700, textAlign: "right" }}
                  />
                </div>
              ))}
              <div style={{ fontSize: 11, color: C.textSec, paddingTop: 6 }}>
                各回戦の試合数はすべて手入力です。シードや不戦勝がある場合もここで調整してください。
              </div>
            </div>
          </div>

          {currentScope === "ALL" && blockLabels.length > 0 && (
            <div style={{ ...S.card, marginBottom: 14, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 10 }}>
                すでに{blockLabels.join("・")}ブロックに分かれています。既存ブロックの内容を上書きしないよう、ここからの再分割はできません。各ブロックの試合数は、上のチップで切り替えて個別に修正してください。
              </div>
              <button style={{ background: "none", border: "none", color: C.red, fontSize: 12, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }} onClick={resetBlocks}>ブロックをリセットしてやり直す ▸</button>
            </div>
          )}

          {skippedInfo && (
            <div style={{ ...S.card, marginBottom: 14, background: C.redL, border: "1px solid " + C.red, padding: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.red, marginBottom: 6 }}>一部のラウンドは試合数を減らせませんでした</div>
              {Object.entries(skippedInfo).map(([scope, rounds]) => rounds.map((s, i) => (
                <div key={scope + "-" + i} style={{ fontSize: 11.5, color: C.text, marginBottom: 2 }}>
                  {scope === "ALL" ? "すべて" : scope + "ブロック"}・第{s.round}回戦：{s.current}試合→{s.desired}試合にしたいが、対戦情報が入っていない枠が{s.emptyAvailable}件しかありません。対戦情報が入っている試合を減らすには、その試合を開いて個別に削除してください。
                </div>
              )))}
            </div>
          )}

          <button
            style={{ width: "100%", padding: 13, background: `linear-gradient(135deg,${C.accent},#00a066)`, color: C.white, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: saving ? 0.7 : 1 }}
            disabled={saving}
            onClick={handleCreate}
          >{saving ? "作成中..." : "この内容でドローを作成"}</button>
          <div style={{ fontSize: 11, color: C.textSec, textAlign: "center", marginTop: 10 }}>
            作成すると「未定 vs 未定・予定」の空枠が各回戦に設定した試合数ぶん自動生成されます。棄権・不戦勝は、枠をタップして開く対戦情報入力画面から個別に設定できます。
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 対戦情報入力シート（ドローの空枠をタップして開く）
// ============================================================
function DrawSideEditor({ label, value, onChange, onWithdrawToggle, roster, schools, mySchoolName, category, locked }) {
  const [pref, setPref] = useState("");
  const set = (patch) => onChange({ ...value, ...patch });

  // ★前の回戦の勝者情報と共有されている枠は、この画面からの編集を禁止する。
  //   同じdraw_entries.idを複数の回戦の枠が参照しているため、ここで編集すると
  //   元になった回戦のデータまで書き換わってしまうため（実際に起きた事故の再発防止）。
  if (locked) {
    return (
      <div style={{ border: "1px solid " + C.border, background: C.gray, borderRadius: 11, padding: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 13, color: C.text, marginBottom: 4 }}>
          {value.schoolName || "（学校名未設定）"}
        </div>
        <div style={{ fontSize: 13, color: C.text }}>
          {[value.player1, value.player2].filter(Boolean).join("・") || "（選手名未設定）"}
        </div>
        <div style={{ fontSize: 11, color: C.textSec, marginTop: 8, lineHeight: 1.5 }}>
          🔒 前の回戦の勝者情報と共有されているため、ここでは編集できません。修正する場合は、元になった回戦の対戦情報から編集してください。
        </div>
      </div>
    );
  }

  // 新規試合登録画面と同じ絞り込み方：入力中の学校名(team_name)に一致する選手だけをチップ表示。
  // 自チームの学校名が入っている場合は is_own_team のメンバーも合わせて表示する。
  const filteredRoster = roster.filter(p =>
    !value.schoolName
      ? false
      : p.team_name === value.schoolName || (value.schoolName === mySchoolName && p.is_own_team !== false)
  );

  // ★選手名は他画面（選手マスター・試合記録など）との互換性のため、内部的には
  //   「姓 名」の1つの文字列（value.player1 / value.player2）のまま保持する。
  //   入力欄だけ姓・名の2つに分け、変更のたびに結合して保存する
  //   （将来、選手マスターを姓・名で取り込む場合にも合わせやすい形）。
  const splitName = (full) => {
    const s = (full || "").trim();
    if (!s) return { sei: "", mei: "" };
    const i = s.search(/[ 　]/); // 半角・全角スペースどちらにも対応
    if (i === -1) return { sei: s, mei: "" };
    return { sei: s.slice(0, i), mei: s.slice(i + 1).trim() };
  };
  const joinName = (sei, mei) => [sei.trim(), mei.trim()].filter(Boolean).join(" ");

  const p1 = splitName(value.player1);
  const p2 = splitName(value.player2);

  return (
    <div style={{ border: "1px solid " + (value.isWithdrawn ? C.red : C.border), background: value.isWithdrawn ? C.redL : C.white, borderRadius: 11, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <b style={{ fontSize: 12.5 }}>{label}</b>
        <button
          style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 99, border: "1px solid " + (value.isWithdrawn ? C.red : C.border), background: value.isWithdrawn ? C.red : C.white, color: value.isWithdrawn ? C.white : C.textSec, cursor: "pointer" }}
          onClick={() => onWithdrawToggle ? onWithdrawToggle(!value.isWithdrawn) : set({ isWithdrawn: !value.isWithdrawn })}
        >棄権にする</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <label style={{ fontSize: 11, color: C.textSec }}>エントリー番号</label>
      </div>
      <input
        style={{ width: "100%", boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 10 }}
        placeholder="例：12"
        value={value.entryNo}
        onChange={e => set({ entryNo: e.target.value })}
        inputMode="numeric"
      />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <label style={{ fontSize: 11, color: C.textSec }}>チーム名 / 学校名</label>
        <PrefMiniFilter value={pref} onChange={setPref} options={knownPrefsFrom(schools)} />
      </div>
      <SchoolField value={value.schoolName} onChange={v => set({ schoolName: v })} schools={schools} placeholder="例：東福岡" prefFilter={pref} />

      {category !== "team" && (
        <>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: C.textSec }}>選手1</label>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input style={{ flex: 1, minWidth: 0, boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", fontSize: 13 }} placeholder="姓" value={p1.sei} onChange={e => set({ player1: joinName(e.target.value, p1.mei) })} />
              <input style={{ flex: 1, minWidth: 0, boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", fontSize: 13 }} placeholder="名" value={p1.mei} onChange={e => set({ player1: joinName(p1.sei, e.target.value) })} />
            </div>
            {filteredRoster.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {filteredRoster.map(p => (
                  <span key={p.id} style={S.chip(value.player1 === p.player_name)} onClick={() => set({ player1: p.player_name })}>{p.player_name}</span>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: C.textSec }}>選手2（ペア）</label>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input style={{ flex: 1, minWidth: 0, boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", fontSize: 13 }} placeholder="姓" value={p2.sei} onChange={e => set({ player2: joinName(e.target.value, p2.mei) })} />
              <input style={{ flex: 1, minWidth: 0, boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", fontSize: 13 }} placeholder="名" value={p2.mei} onChange={e => set({ player2: joinName(p2.sei, e.target.value) })} />
            </div>
            {filteredRoster.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {filteredRoster.map(p => (
                  <span key={p.id} style={S.chip(value.player2 === p.player_name)} onClick={() => set({ player2: p.player_name })}>{p.player_name}</span>
                ))}
              </div>
            )}
          </div>

          {value.schoolName && filteredRoster.length === 0 && (
            <div style={{ fontSize: 10.5, color: C.textSec, marginTop: 8 }}>マスター画面の「👥 選手マスター」でこの学校の選手を登録しておくと、ここで選んで入力できます。</div>
          )}
        </>
      )}
    </div>
  );
}

function DrawEntrySheet({ drawMatch, tournament, category, blockLabel, roundLabel, matchLabel, mySchoolName, onClose, onSaved, prefillSchoolA, prefillSchoolB, sideALocked, sideBLocked }) {
  const [roster, setRoster] = useState([]);
  const [schools, setSchools] = useState([]);
  const [saving, setSaving] = useState(false);

  // ★「自チーム/相手チーム」という区別は入力時にはなくし、上側/下側という中立な2枠として扱う。
  //   内部的には従来どおりサイドA/サイドBとして保存する（スコア判定・色分けは変更しない）。
  const emptySide = (prefillSchool) => ({ schoolName: prefillSchool || "", player1: "", player2: "", isWithdrawn: false, entryNo: "" });

  const initSide = (entry, prefillSchool) => {
    if (!entry) return emptySide(prefillSchool);
    return {
      schoolName: entry.school_name || "",
      player1: entry.player1_name || "",
      player2: entry.player2_name || "",
      isWithdrawn: !!entry.is_withdrawn,
      entryNo: entry.entry_no != null ? String(entry.entry_no) : "",
    };
  };

  // ★入力途中のデータが消えないよう、この枠の下書きをlocalStorageに自動保存する。
  //   ただし「最新の登録内容」より下書きの方が古い可能性があるため、無条件には復元せず必ず確認する。
  const draftKey = `draw_entry_draft_${drawMatch.id}`;
  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch (e) {} };

  // ★古い形式の下書き（entryNoなどの項目がまだ無かった頃のもの）を復元しても
  //   壊れないよう、欠けている項目はデフォルト値で補完する
  const normalizeSide = (v) => ({
    schoolName: v?.schoolName || "",
    player1: v?.player1 || "",
    player2: v?.player2 || "",
    isWithdrawn: !!v?.isWithdrawn,
    entryNo: v?.entryNo != null ? String(v.entryNo) : "",
  });

  // ★下書きの確認(window.confirm)と読み込みは、マウント時（画面を開いた瞬間）に
  //   1回だけ行う。以前はコンポーネント本体に直接書かれていたため、入力するたびの
  //   再レンダリングで毎回confirmが再実行されてしまっていた（重大な不具合だったため修正）。
  const [initialSides] = useState(() => {
    let raw = null;
    try { raw = localStorage.getItem(draftKey); } catch (e) {}
    const draft = raw ? JSON.parse(raw) : null;
    let useDraft = false;
    if (draft) {
      useDraft = window.confirm("前回入力途中のデータが見つかりました。復元しますか？\n「OK」で復元、「キャンセル」で現在登録されている内容を表示します。");
      // 復元する・しないに関わらず、確認済みの下書きはここで必ず消す
      // （消さないと次の入力のたびに同じ確認が繰り返されてしまう）
      try { localStorage.removeItem(draftKey); } catch (e) {}
    }
    return {
      sideA: useDraft ? normalizeSide(draft.sideA) : initSide(drawMatch.sideA, prefillSchoolA),
      sideB: useDraft ? normalizeSide(draft.sideB) : initSide(drawMatch.sideB, prefillSchoolB),
    };
  });

  const [sideA, setSideA] = useState(initialSides.sideA);
  const [sideB, setSideB] = useState(initialSides.sideB);

  // ★サーバーに登録済みの内容と比較するための「元の状態」（プリフィルを含む）
  const originalSideARef = useRef(initSide(drawMatch.sideA, prefillSchoolA));
  const originalSideBRef = useRef(initSide(drawMatch.sideB, prefillSchoolB));

  useEffect(() => {
    // ★登録済みの内容と何も変わっていなければ、下書きは保存しない
    //   （毎回「復元しますか？」と聞かれてしまう問題を防ぐ）
    const unchanged =
      JSON.stringify(sideA) === JSON.stringify(originalSideARef.current) &&
      JSON.stringify(sideB) === JSON.stringify(originalSideBRef.current);
    try {
      if (unchanged) {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(draftKey, JSON.stringify({ sideA, sideB }));
      }
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideA, sideB]);

  useEffect(() => {
    getPlayerRoster().then(setRoster);
    getSchools().then(setSchools);
  }, []);

  // ★表示（上側/下側）は、この画面を開いた時点のentry_noの若い順で1回だけ決める。
  //   入力中の値が変わるたびに再計算すると、タイプ中に上側/下側の中身が入れ替わって
  //   見えてしまう（実際のデータは壊れていないが、非常に紛らわしい）ため、固定にする。
  const [topKey] = useState(() => {
    const a0 = originalSideARef.current;
    const b0 = originalSideBRef.current;
    const aNo0 = (a0.entryNo || "").trim() !== "" ? Number(a0.entryNo) : null;
    const bNo0 = (b0.entryNo || "").trim() !== "" ? Number(b0.entryNo) : null;
    const swap0 = aNo0 != null && bNo0 != null && !Number.isNaN(aNo0) && !Number.isNaN(bNo0) && aNo0 > bNo0;
    return swap0 ? "B" : "A";
  });
  const bottomKey = topKey === "A" ? "B" : "A";
  const valueOf = (key) => (key === "A" ? sideA : sideB);
  const setterOf = (key) => (key === "A" ? setSideA : setSideB);

  const buildEntryRow = (side, val) => ({
    id: (side === "A" ? drawMatch.side_a_entry_id : drawMatch.side_b_entry_id) || uid(),
    tournament_id: tournament.id, category, block_label: blockLabel,
    is_own_team: val.schoolName === mySchoolName, school_name: val.schoolName,
    player1_name: val.player1, player2_name: val.player2, is_withdrawn: val.isWithdrawn,
    entry_no: val.entryNo ? String(val.entryNo).trim() : null,
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      // ★保存直前に必ず最新のdraw_matchesを取得し、他の人が既に登録していないか確認する
      const fresh = await getDrawMatchRaw(drawMatch.id);
      const aTakenNow = !!fresh.side_a_entry_id;
      const bTakenNow = !!fresh.side_b_entry_id;
      // ★編集画面を開いた時点で既に入っていた側は「編集」とみなし、保存を許可する。
      //   開いた時点で空欄だった側だけ、他の人が同時に登録していないかを確認する。
      const wasTakenA = !!drawMatch.side_a_entry_id;
      const wasTakenB = !!drawMatch.side_b_entry_id;
      const conflictA = !wasTakenA && aTakenNow;
      const conflictB = !wasTakenB && bTakenNow;

      if (conflictA && conflictB) {
        alert("この試合枠は既に登録されています。最新の内容を表示します。");
        clearDraft();
        onClose();
        await onSaved();
        return;
      }

      // entry_noの重複チェック（同じ大会・同じブロック内で、他のエントリーと重複していないか）
      const excludeIds = [drawMatch.side_a_entry_id, drawMatch.side_b_entry_id].filter(Boolean);
      if (!conflictA && (sideA.entryNo || "").trim()) {
        if (await checkDuplicateEntryNo(tournament.id, category, blockLabel, sideA.entryNo.trim(), excludeIds)) {
          alert(`エントリー番号「${sideA.entryNo.trim()}」は既に他の枠で使われています。番号を確認してください。`);
          setSaving(false);
          return;
        }
      }
      if (!conflictB && (sideB.entryNo || "").trim()) {
        if (await checkDuplicateEntryNo(tournament.id, category, blockLabel, sideB.entryNo.trim(), excludeIds)) {
          alert(`エントリー番号「${sideB.entryNo.trim()}」は既に他の枠で使われています。番号を確認してください。`);
          setSaving(false);
          return;
        }
      }

      // 開いた時点で空欄だった側が、保存直前に他の人によって埋まっていた場合だけ上書きしない
      // ★前の回戦と共有されている側（sideALocked/sideBLocked）も、ここでは絶対に上書きしない
      let skippedSide = null;
      let lockedSkipped = null;
      if (sideALocked) { lockedSkipped = "上側"; }
      else if (!conflictA) {
        const entryA = await saveDrawEntry(buildEntryRow("A", sideA));
        await setDrawMatchSideSafe(drawMatch.id, "A", entryA.id).catch(() => {}); // ★既に同じentry_idなら何もしない（更新自体はsaveDrawEntryで完了済み）
      } else { skippedSide = "上側"; }
      if (sideBLocked) { lockedSkipped = lockedSkipped ? "両側" : "下側"; }
      else if (!conflictB) {
        const entryB = await saveDrawEntry(buildEntryRow("B", sideB));
        await setDrawMatchSideSafe(drawMatch.id, "B", entryB.id).catch(() => {});
      } else { skippedSide = skippedSide ? "両側" : "下側"; }

      if (lockedSkipped) {
        alert(`${lockedSkipped}は前の回戦の勝者情報と共有されているため、この画面では変更できませんでした。修正する場合は、元になった回戦の対戦情報から編集してください。`);
      }
      if (skippedSide) {
        alert(`${skippedSide}は既に他の方が登録済みだったため、そちらは上書きせずもう一方だけ保存しました。`);
      }

      clearDraft();
      onClose();
      await onSaved();
    } catch (e) {
      alert("保存エラー: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  // ★棄権ボタンが押されたときの処理
  //   ・棄権を解除する場合（trueにする前段階）はローカルの状態を戻すだけ
  //   ・棄権にする場合は確認ダイアログを出し、「はい」なら即座に保存＋相手の不戦勝で試合を終了扱いにする
  //   ・保存直前に最新状態を確認し、既に埋まっている側は上書きしない
  const handleWithdrawToggle = async (side, newVal) => {
    if (!newVal) {
      if (side === "A") setSideA(v => ({ ...v, isWithdrawn: false }));
      else setSideB(v => ({ ...v, isWithdrawn: false }));
      return;
    }
    if (!window.confirm("この対戦を棄権として扱いますか？\n「OK」にすると、相手の不戦勝としてこの試合が終了扱いになります。")) return;

    const nextSideA = side === "A" ? { ...sideA, isWithdrawn: true } : sideA;
    const nextSideB = side === "B" ? { ...sideB, isWithdrawn: true } : sideB;
    setSideA(nextSideA);
    setSideB(nextSideB);

    setSaving(true);
    try {
      const fresh = await getDrawMatchRaw(drawMatch.id);
      const aTaken = !!fresh.side_a_entry_id;
      const bTaken = !!fresh.side_b_entry_id;

      if (aTaken && bTaken) {
        alert("この試合枠は既に登録されています。最新の内容を表示します。");
        clearDraft();
        onClose();
        await onSaved();
        return;
      }

      let entryA = null, entryB = null;
      if (!aTaken) { entryA = await saveDrawEntry(buildEntryRow("A", nextSideA)); await setDrawMatchSideSafe(drawMatch.id, "A", entryA.id); }
      if (!bTaken) { entryB = await saveDrawEntry(buildEntryRow("B", nextSideB)); await setDrawMatchSideSafe(drawMatch.id, "B", entryB.id); }

      // 棄権していない側（勝ち上がる側）に選手名が1人でも入っていれば、不戦勝で試合を終了扱いにする
      // （選手2しか入力されていないケースにも対応）
      const winnerSide = side === "A" ? "B" : "A";
      const winnerEntry = winnerSide === "A" ? (entryA || drawMatch.sideA) : (entryB || drawMatch.sideB);
      if (winnerEntry && (winnerEntry.player1_name || winnerEntry.player2_name)) {
        await createWalkoverMatch({ ...drawMatch, sideA: entryA || drawMatch.sideA, sideB: entryB || drawMatch.sideB }, tournament.name, roundLabel, winnerSide);
      }
      clearDraft();
      onClose();
      await onSaved();
    } catch (e) {
      alert("保存エラー: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => { clearDraft(); onClose(); };

  return (
    <Modal onClose={handleClose}>
      <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{matchLabel}の対戦情報を入力</div>
          <button
            style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
            onClick={handleClose}
            aria-label="閉じる"
          >×</button>
        </div>
        <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 14 }}>紙のドロー表を見ながら、上から順にそのまま入力できます。エントリー番号を両方入れると、若い番号が自動的に上に表示されます。</div>
        {(prefillSchoolA || prefillSchoolB) && (
          <div style={{ fontSize: 11, color: C.navy, background: C.accentL, borderRadius: 8, padding: "8px 10px", marginBottom: 14 }}>
            📋 他の枠から学校名をコピーしました。選手名とエントリー番号を入力してください。
          </div>
        )}
        {drawMatch.match_id && (
          <div style={{ fontSize: 11, color: C.orange, background: "#fff3e0", borderRadius: 8, padding: "8px 10px", marginBottom: 14 }}>
            ⚠️ この枠はすでに試合が作成されています。ここでの変更はドロー表の表示に反映されますが、作成済みの試合記録（選手名など）は自動では更新されません。試合記録自体を直すには「編集」からその試合を開いて修正してください。
          </div>
        )}
        <DrawSideEditor label="上側" value={valueOf(topKey)} onChange={setterOf(topKey)} onWithdrawToggle={(v) => handleWithdrawToggle(topKey, v)} roster={roster} schools={schools} mySchoolName={mySchoolName} category={category} locked={topKey === "A" ? sideALocked : sideBLocked} />
        <DrawSideEditor label="下側" value={valueOf(bottomKey)} onChange={setterOf(bottomKey)} onWithdrawToggle={(v) => handleWithdrawToggle(bottomKey, v)} roster={roster} schools={schools} mySchoolName={mySchoolName} category={category} locked={bottomKey === "A" ? sideALocked : sideBLocked} />
        <button
          style={{ width: "100%", padding: 13, background: `linear-gradient(135deg,${C.accent},#00a066)`, color: C.white, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8, opacity: saving ? 0.7 : 1 }}
          disabled={saving} onClick={handleSave}
        >{saving ? "保存中..." : "対戦を登録する"}</button>
        <button style={{ width: "100%", padding: 13, background: C.gray, color: C.text, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }} onClick={handleClose}>閉じる</button>
      </div>
    </Modal>
  );
}

// ============================================================
// トーナメント表（ドローの実データ表示）
// ============================================================
function DrawBracket({ tournament, category, mySchoolName, onOpenMatch, onCopyMatch }) {
  const [blockLabels, setBlockLabels] = useState([]);
  const [selectedBlock, setSelectedBlock] = useState(null); // null = ブロックなし("すべて"扱い)
  const [drawMatches, setDrawMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingSlot, setEditingSlotRaw] = useState(null); // タップ中のdrawMatch
  const [startingId, setStartingId] = useState(null);
  const [advancingId, setAdvancingId] = useState(null);
  const [advancingFrom, setAdvancingFrom] = useState(null); // 進出先を選択中のdrawMatch（終了した試合）
  const [longPressMatch, setLongPressMatch] = useState(null); // 長押しでアクションシートを開いた対象
  const [copySourceMatch, setCopySourceMatch] = useState(null); // 対戦情報をコピーする元
  const [copyPrefill, setCopyPrefill] = useState(null); // 編集シートに渡す学校名のプリフィル { schoolA, schoolB }
  const [confirmDeleteMatch, setConfirmDeleteMatch] = useState(null); // 削除確認中のmatch_id
  const [deletingMatch, setDeletingMatch] = useState(false);
  const longPressTimerRef = useRef(null);
  const longPressFiredRef = useRef(false);
  const [adjustingRound, setAdjustingRound] = useState(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false); // 一括登録モーダル
  const [bulkText, setBulkText] = useState("");
  const [bulkTargetRound, setBulkTargetRound] = useState(1);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [simpleResultFor, setSimpleResultFor] = useState(null); // 「結果だけ記録」モーダルの対象drawMatch
  const [simpleResultWinner, setSimpleResultWinner] = useState("A");
  const [simpleResultScoreA, setSimpleResultScoreA] = useState("");
  const [simpleResultScoreB, setSimpleResultScoreB] = useState("");
  const [savingSimpleResult, setSavingSimpleResult] = useState(false);

  // ★対戦情報入力シートを開いている最中に他アプリへ移動して戻ってきても、
  //   画面が閉じてしまわないよう、「どの枠を編集中か」をlocalStorageにも覚えておく。
  //   （入力内容そのものはDrawEntrySheet側のdraftKeyで既に保存されている）
  const editingSlotStorageKey = `draw_editing_slot_${tournament.id}_${category}`;
  const openEditingSlot = (dm) => {
    setEditingSlotRaw(dm);
    try { localStorage.setItem(editingSlotStorageKey, dm.id); } catch (e) {}
  };
  const closeEditingSlot = () => {
    setEditingSlotRaw(null);
    setCopyPrefill(null);
    try { localStorage.removeItem(editingSlotStorageKey); } catch (e) {}
  };

  // ★勝者が変わった（結果を修正した）ときに、既に次の回戦へ進出させていた側だけを
  //   新しい勝者へ差し替える。次の回戦の枠に既に結果が入っている場合は、
  //   自動上書きせず必ず確認する。
  const syncWinnerToNextMatch = async (dm, previousWinnerEntry, newWinnerEntry) => {
    if (!previousWinnerEntry) return; // まだ進出させていなければ何もしない
    const nextRound = rounds[dm.round_no + 1] || [];
    const target = nextRound.find(x => x.side_a_entry_id === previousWinnerEntry.id || x.side_b_entry_id === previousWinnerEntry.id);
    if (!target) return; // 次の回戦にまだ進出させていない
    if (newWinnerEntry && target.side_a_entry_id === newWinnerEntry.id) return; // 既に新しい勝者になっている
    if (newWinnerEntry && target.side_b_entry_id === newWinnerEntry.id) return;

    const side = target.side_a_entry_id === previousWinnerEntry.id ? "A" : "B";
    const targetProgressed = !!target.match_id || !!target.simple_result_winner;
    if (targetProgressed) {
      const proceed = window.confirm(
        `進出先の${dm.round_no + 1}回戦の対戦には、既に試合結果が入っています。\n` +
        `このまま勝者を差し替えると、その先の結果と矛盾する可能性があります。差し替えますか？`
      );
      if (!proceed) return;
    }
    const { error } = await supabase.from("draw_matches").update({
      [side === "A" ? "side_a_entry_id" : "side_b_entry_id"]: newWinnerEntry ? newWinnerEntry.id : null,
      updated_at: new Date().toISOString(),
    }).eq("id", target.id);
    if (error) throw error;
  };

  // ★団体戦「結果だけ記録」モーダルの開閉・保存
  const openSimpleResultModal = (dm) => {
    setSimpleResultFor(dm);
    setSimpleResultWinner(dm.simple_result_winner || "A");
    setSimpleResultScoreA(dm.simple_result_score_a != null ? String(dm.simple_result_score_a) : "");
    setSimpleResultScoreB(dm.simple_result_score_b != null ? String(dm.simple_result_score_b) : "");
  };
  const closeSimpleResultModal = () => { setSimpleResultFor(null); };
  const handleSaveSimpleResult = async () => {
    if (!simpleResultFor || savingSimpleResult) return; // ★二重押し防止
    const scoreA = Number(simpleResultScoreA);
    const scoreB = Number(simpleResultScoreB);
    if (simpleResultScoreA === "" || simpleResultScoreB === "" || Number.isNaN(scoreA) || Number.isNaN(scoreB)) {
      alert("スコアを両方とも入力してください。");
      return;
    }
    // ★0以上の整数のみ許可（マイナス値・小数を防ぐ）
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      alert("スコアは0以上の整数で入力してください。");
      return;
    }
    // ★競技上あり得ない大きな数値を防ぐ（団体戦＝対戦数、個人戦＝ゲーム数の現実的な上限）
    const maxScore = category === "team" ? 15 : 20;
    if (scoreA > maxScore || scoreB > maxScore) {
      alert(`スコアが大きすぎます（${maxScore}以下で入力してください）。`);
      return;
    }
    if (scoreA === scoreB) {
      alert("スコアが同点になっています。勝敗がわかるスコアを入力してください。");
      return;
    }
    // ★勝者は「選んで指定」ではなく、入力したスコアの大小から自動で決める。
    //   手動選択だと、スコアと勝者の指定が食い違う入力ミスが起きやすいため。
    const winner = scoreA > scoreB ? "A" : "B";
    // ★保存前の勝者を控えておき、保存後に「進出先の差し替え」が必要か判定する
    const prevWinnerSide = simpleResultFor.simple_result_winner;
    const prevWinnerEntry = prevWinnerSide ? (prevWinnerSide === "A" ? simpleResultFor.sideA : simpleResultFor.sideB) : null;
    const newWinnerEntry = winner === "A" ? simpleResultFor.sideA : simpleResultFor.sideB;
    setSavingSimpleResult(true);
    try {
      await saveSimpleTeamResult(simpleResultFor.id, winner, scoreA, scoreB);
      if (prevWinnerEntry && newWinnerEntry && prevWinnerEntry.id !== newWinnerEntry.id) {
        await syncWinnerToNextMatch(simpleResultFor, prevWinnerEntry, newWinnerEntry);
      }
      closeSimpleResultModal();
      await reload();
    } catch (e) {
      alert("保存に失敗しました: " + (e.message || e));
    } finally {
      setSavingSimpleResult(false);
    }
  };
  const handleClearSimpleResult = async () => {
    if (!simpleResultFor) return;
    if (!window.confirm("記録した結果を削除しますか？")) return;
    const prevWinnerSide = simpleResultFor.simple_result_winner;
    const prevWinnerEntry = prevWinnerSide ? (prevWinnerSide === "A" ? simpleResultFor.sideA : simpleResultFor.sideB) : null;
    setSavingSimpleResult(true);
    try {
      await clearSimpleTeamResult(simpleResultFor.id);
      // ★削除した結果、既に次の回戦へ進出させていた選手がいれば、その枠からも外す
      if (prevWinnerEntry) {
        await syncWinnerToNextMatch(simpleResultFor, prevWinnerEntry, null);
      }
      closeSimpleResultModal();
      await reload();
    } catch (e) {
      alert("削除に失敗しました: " + (e.message || e));
    } finally {
      setSavingSimpleResult(false);
    }
  };

  // ★一括登録モーダルも、他アプリ（コピー元の確認など）に移動して戻ってきたときに
  //   閉じてしまったり入力内容が消えたりしないよう、開いている間はlocalStorageに保存する。
  const bulkImportStorageKey = `draw_bulk_import_${tournament.id}_${category}`;
  const saveBulkDraft = (open, text, round) => {
    try {
      if (open) localStorage.setItem(bulkImportStorageKey, JSON.stringify({ text, round }));
      else localStorage.removeItem(bulkImportStorageKey);
    } catch (e) {}
  };
  const openBulkImport = () => {
    setBulkTargetRound(roundNos[0] || 1);
    setBulkImportOpen(true);
  };
  const closeBulkImport = () => {
    setBulkImportOpen(false);
    setBulkText("");
    saveBulkDraft(false);
  };
  const updateBulkText = (text) => {
    setBulkText(text);
    saveBulkDraft(true, text, bulkTargetRound);
  };
  const updateBulkTargetRound = (round) => {
    setBulkTargetRound(round);
    saveBulkDraft(true, bulkText, round);
  };

  const reload = useCallback(async () => {
    setLoading(true);
    const labels = await getDrawBlockLabels(tournament.id, category);
    setBlockLabels(labels);
    const scope = labels.length > 0 ? (selectedBlock && labels.includes(selectedBlock) ? selectedBlock : labels[0]) : null;
    setSelectedBlock(scope);
    const rows = await getDrawMatchesWithEntries(tournament.id, category, scope);
    setDrawMatches(rows);
    setLoading(false);

    // 編集中だった枠が記録されていれば、対戦情報入力シートを自動で復元する
    // （既に試合が作成済みになっている場合は復元しない＝入力の必要がなくなったため）
    try {
      const savedId = localStorage.getItem(editingSlotStorageKey);
      if (savedId) {
        const found = rows.find(r => r.id === savedId);
        if (found && !found.match_id) {
          setEditingSlotRaw(found);
        } else {
          localStorage.removeItem(editingSlotStorageKey);
        }
      }
    } catch (e) {}

    // 一括登録モーダルが開いたままだった場合も、入力内容ごと自動で復元する
    try {
      const rawBulk = localStorage.getItem(bulkImportStorageKey);
      if (rawBulk) {
        const saved = JSON.parse(rawBulk);
        setBulkText(saved.text || "");
        setBulkTargetRound(saved.round || 1);
        setBulkImportOpen(true);
      }
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament.id, category]);

  useEffect(() => { reload(); }, [reload]);

  const switchBlock = async (label) => {
    setSelectedBlock(label);
    setLoading(true);
    const rows = await getDrawMatchesWithEntries(tournament.id, category, label);
    setDrawMatches(rows);
    setLoading(false);
  };

  const rounds = {};
  drawMatches.forEach(m => { (rounds[m.round_no] = rounds[m.round_no] || []).push(m); });
  const roundNos = Object.keys(rounds).map(Number).sort((a, b) => a - b);

  const entryLabel = (entry) => {
    if (!entry) return "未定";
    const names = [entry.player1_name, entry.player2_name].filter(Boolean).join("・") || (entry.school_name || "未定");
    return names;
  };

  // ★試合開始可能なエントリーかどうかの判定
  //   ・棄権(is_withdrawn)は対象外
  //   ・選手名(player1_name)が空/空白のみのエントリーも対象外
  const isPlayableEntry = (e) => !!(e && !e.is_withdrawn && (e.player1_name?.trim() || e.school_name?.trim()));

  const startMatch = async (dm) => {
    if (startingId) return; // ★連打防止：作成処理中は他の枠のタップも受け付けない
    setStartingId(dm.id);
    try {
      const roundLabel = `${dm.round_no}回戦`;
      const matchId = await createMatchFromDrawSlot(dm, tournament.name, roundLabel);
      await reload();
      onOpenMatch(matchId);
    } catch (e) {
      alert("試合作成エラー: " + (e.message || e));
    } finally {
      setStartingId(null);
    }
  };

  // 終了した試合の勝者エントリーを求める
  // ★優先順位：実際の試合（matches）が終了していればそちらを必ず優先する。
  //   「結果だけ記録」は、実試合が作られていない枠にだけ意味を持つ簡易的な記録のため。
  const getWinnerEntry = (dm) => {
    const mi = dm.matchInfo;
    if (mi && mi.status === "finished") return mi.match_score_a > mi.match_score_b ? dm.sideA : dm.sideB;
    if (dm.simple_result_winner) return dm.simple_result_winner === "A" ? dm.sideA : dm.sideB;
    return null;
  };

  // 勝者が既に次ラウンドのどこかの枠に入っているか（同じentry idで検索）
  const isAlreadyAdvanced = (dm, winnerEntry) => {
    if (!winnerEntry) return false;
    const nextRound = rounds[dm.round_no + 1] || [];
    return nextRound.some(x => (x.sideA && x.sideA.id === winnerEntry.id) || (x.sideB && x.sideB.id === winnerEntry.id));
  };

  // 選ばれた枠・サイドに勝者を進出させる
  const advanceWinner = async (targetSlotId, targetSide, winnerEntry) => {
    if (!winnerEntry || advancingId) return;
    setAdvancingId(targetSlotId);
    try {
      const result = await setDrawMatchSideSafe(targetSlotId, targetSide, winnerEntry.id);
      if (!result.ok) {
        alert("この枠には、既に別の対戦相手が登録されていました。上書きは行いませんでした。最新の状態を確認してください。");
      }
      await reload();
      setAdvancingFrom(null);
    } catch (e) {
      alert("進出処理エラー: " + (e.message || e));
    } finally {
      setAdvancingId(null);
    }
  };

  // ★長押しで「コピーして新規作成」「削除」を選べるアクションシートを開く（作成済みの試合のみ対象）
  const startLongPress = (dm) => {
    if (!dm.match_id) return;
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      if (navigator.vibrate) navigator.vibrate(15);
      setLongPressMatch(dm);
    }, 550);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  };

  const handleDeleteMatch = async (matchId, drawMatchId) => {
    setDeletingMatch(true);
    try {
      await deleteMatch(matchId);
      if (drawMatchId) await clearDrawMatchLink(drawMatchId);
      setConfirmDeleteMatch(null);
      setLongPressMatch(null);
      await reload();
    } catch (e) {
      alert("削除エラー: " + (e.message || e));
    } finally {
      setDeletingMatch(false);
    }
  };

  // ★一括登録：1行1エントリーのテキストを解析し、上から順に2件ずつペアにして
  //   選んだ回戦の枠へ登録する（エントリー1・2→第1試合、3・4→第2試合…という並び）。
  //   行の内容が「-」だけの場合は「まだ相手が決まっていない（シード等）」を意味し、
  //   その側の枠は空欄のままにする（後で「勝者を進出させる」から埋める）。
  //   既に対戦情報が入っている枠・重複するエントリー番号はスキップし、結果をまとめて報告する。
  const parseBulkLines = (text) => {
    return text.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
      if (line === "-") return null; // 相手未定（空欄）マーカー
      const cols = line.includes("\t") ? line.split("\t") : line.split(/,|　| {2,}/);
      const [entryNo, school, player1, player2] = cols.map(c => (c || "").trim());
      return { entryNo, school: school || "", player1: player1 || "", player2: player2 || "" };
    });
  };

  const handleBulkImport = async () => {
    const entries = parseBulkLines(bulkText);
    if (entries.length === 0) { alert("入力内容がありません。"); return; }
    const targetSlots = (rounds[bulkTargetRound] || []).slice().sort((a, b) => a.slot_no - b.slot_no);
    if (targetSlots.length === 0) { alert(`${bulkTargetRound}回戦の枠が見つかりません。`); return; }
    if (entries.length > targetSlots.length * 2) {
      if (!window.confirm(`入力されたエントリー数(${entries.length}件)が、${bulkTargetRound}回戦の枠数(${targetSlots.length}試合＝${targetSlots.length * 2}エントリー分)より多いです。入りきらない分は無視されますが、続けますか？`)) return;
    }

    setBulkImporting(true);
    let registered = 0, skippedFull = 0, skippedDup = 0, errors = 0;
    let entryIdx = 0; // ★entriesを消費するための独立したカーソル。既に埋まっている枠をスキップしても、この位置はずれない。
    try {
      for (let i = 0; i < targetSlots.length; i++) {
        if (entryIdx >= entries.length) break; // もう対応するエントリーがない

        const slot = targetSlots[i];
        const fresh = await getDrawMatchRaw(slot.id);
        const aTaken = !!fresh.side_a_entry_id;
        const bTaken = !!fresh.side_b_entry_id;
        // ★片側だけ埋まっている枠（シード選手が「勝者進出待ち」で登録されている等）は、
        //   一括登録では絶対に触らない。そういう枠は「勝者を進出させる」からのみ埋める。
        if (aTaken || bTaken) { skippedFull++; continue; } // ★entriesは消費しない

        // この枠がまだ必要としている側の分だけ、entriesから順番に取り出す
        const eA = !aTaken ? entries[entryIdx++] : null;
        const eB = (!bTaken && entryIdx < entries.length) ? entries[entryIdx++] : null;
        if (!eA && !eB) continue;

        try {
          if (eA && !aTaken) {
            if (eA.entryNo && await checkDuplicateEntryNo(tournament.id, category, selectedBlock, eA.entryNo, [])) { skippedDup++; }
            else {
              const entryA = await saveDrawEntry({
                id: uid(), tournament_id: tournament.id, category, block_label: selectedBlock,
                is_own_team: eA.school === mySchoolName, school_name: eA.school,
                player1_name: eA.player1, player2_name: eA.player2, is_withdrawn: false,
                entry_no: eA.entryNo || null,
              });
              await setDrawMatchSideSafe(slot.id, "A", entryA.id);
              registered++;
            }
          }
          if (eB && !bTaken) {
            if (eB.entryNo && await checkDuplicateEntryNo(tournament.id, category, selectedBlock, eB.entryNo, [])) { skippedDup++; }
            else {
              const entryB = await saveDrawEntry({
                id: uid(), tournament_id: tournament.id, category, block_label: selectedBlock,
                is_own_team: eB.school === mySchoolName, school_name: eB.school,
                player1_name: eB.player1, player2_name: eB.player2, is_withdrawn: false,
                entry_no: eB.entryNo || null,
              });
              await setDrawMatchSideSafe(slot.id, "B", entryB.id);
              registered++;
            }
          }
        } catch (e) {
          errors++;
        }
      }
      alert(`登録完了：${registered}件のエントリーを登録しました。${skippedFull ? `\n既に埋まっていた枠：${skippedFull}試合分はスキップ` : ""}${skippedDup ? `\n重複するエントリー番号：${skippedDup}件はスキップ` : ""}${errors ? `\nエラー：${errors}件` : ""}`);
      closeBulkImport();
      await reload();
    } catch (e) {
      alert("一括登録エラー: " + (e.message || e));
    } finally {
      setBulkImporting(false);
    }
  };

  // この画面から直接、回戦ごとの試合数を1試合ずつ増減する
  const adjustRoundCount = async (roundNo, delta) => {
    const maxRound = Math.max(...roundNos);
    const desiredCounts = [];
    for (let i = 1; i <= maxRound; i++) {
      desiredCounts.push(i === roundNo ? Math.max(1, (rounds[i] || []).length + delta) : (rounds[i] || []).length);
    }
    setAdjustingRound(roundNo);
    try {
      const { skippedRounds } = await saveDrawRounds(tournament.id, category, selectedBlock, desiredCounts);
      if (skippedRounds.length) {
        const s = skippedRounds[0];
        alert(`第${s.round}回戦は、対戦情報が入っていない枠が${s.emptyAvailable}件しかないため、これ以上減らせません。対戦情報が入っている試合を減らすには、その試合を個別に削除してください。`);
      }
      await reload();
    } catch (e) {
      alert("更新エラー: " + (e.message || e));
    } finally {
      setAdjustingRound(null);
    }
  };

  if (loading) return <div style={{ textAlign: "center", color: C.textSec, marginTop: 30 }}>ドローを読み込み中...</div>;
  if (drawMatches.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {blockLabels.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 10 }}>
          {blockLabels.map(l => (
            <button key={l} style={chipStyle(selectedBlock === l)} onClick={() => switchBlock(l)}>{l}ブロック</button>
          ))}
        </div>
      )}
      <div style={{ textAlign: "right", marginBottom: 10 }}>
        <button
          style={{ border: "1px solid " + C.navy, background: C.white, color: C.navy, borderRadius: 8, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: "6px 12px" }}
          onClick={openBulkImport}
        >📋 一覧から一括登録</button>
      </div>
      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ display: "flex", gap: 10, minWidth: roundNos.length * 190 }}>
          {roundNos.map(rn => (
            <div key={rn} style={{ width: 180, flex: "none" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 10 }}>
                <button
                  style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid " + C.border, background: C.white, fontSize: 13, fontWeight: 700, color: C.navy, cursor: "pointer", flex: "none" }}
                  disabled={adjustingRound === rn}
                  onClick={() => adjustRoundCount(rn, -1)}
                >－</button>
                <div style={{ flex: 1, textAlign: "center", fontWeight: 800, fontSize: 11.5, color: C.navy, background: C.accentL, borderRadius: 7, padding: "4px 0" }}>
                  {rn}回戦（{rounds[rn].length}試合）
                </div>
                <button
                  style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid " + C.border, background: C.white, fontSize: 13, fontWeight: 700, color: C.navy, cursor: "pointer", flex: "none" }}
                  disabled={adjustingRound === rn}
                  onClick={() => adjustRoundCount(rn, 1)}
                >＋</button>
              </div>
              {rounds[rn].sort((a, b) => a.slot_no - b.slot_no).map((dm, idx) => {
                const filled = isPlayableEntry(dm.sideA) && isPlayableEntry(dm.sideB);
                const hasWithdrawn = (dm.sideA && dm.sideA.is_withdrawn) || (dm.sideB && dm.sideB.is_withdrawn);
                const mi = dm.matchInfo;
                const isWalkover = !!(mi && mi.memo && mi.memo.includes("不戦勝"));
                // ★優先順位：実際の試合（matches）が終了していればそちらを必ず優先する。
                //   「結果だけ記録」は、実試合が作られていない/終了していない枠にだけ意味を持つ。
                const realFinished = mi && mi.status === "finished";
                const hasSimpleResult = !realFinished && !!dm.simple_result_winner;
                const winnerSide = realFinished ? (mi.match_score_a > mi.match_score_b ? "A" : "B")
                  : hasSimpleResult ? dm.simple_result_winner
                  : null;
                const borderColor = mi && mi.status === "active" ? C.orange : mi && mi.status === "waiting" ? C.purple : C.border;
                const winnerEntry = winnerSide ? (winnerSide === "A" ? dm.sideA : dm.sideB) : null;
                const alreadyAdvanced = winnerSide ? isAlreadyAdvanced(dm, winnerEntry) : false;

                const sideRow = (side, isFirstRow) => {
                  const entry = side === "A" ? dm.sideA : dm.sideB;
                  const isWinner = winnerSide === side;
                  // ★色は「勝敗」ではなく「自チーム／相手」を表す（自チームのエントリーのみ緑）。
                  //   勝敗は色ではなく太字＋🏆で示す。
                  const nameColor = !entry ? C.textSec : entry.is_own_team ? C.teamA : C.text;
                  const scoreVal = hasSimpleResult ? (side === "A" ? dm.simple_result_score_a : dm.simple_result_score_b)
                    : !mi ? null
                    : mi.status === "active" ? (side === "A" ? mi.match_score_a : mi.match_score_b)
                    : mi.status === "finished" ? (isWalkover ? (isWinner ? "R" : "-") : (side === "A" ? mi.match_score_a : mi.match_score_b))
                    : null;
                  const scoreColor = mi && mi.status === "active" ? C.orange : nameColor;
                  return (
                    <div style={{ padding: "7px 9px", borderBottom: isFirstRow ? "1px solid " + C.border : "none", fontSize: 11.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: isWinner ? 800 : 400, color: nameColor }}>
                          {entry && entry.entry_no && <span style={{ color: C.textSec, marginRight: 4 }}>{entry.entry_no}</span>}
                          {entryLabel(entry)}{isWinner && " 🏆"}
                        </div>
                        {entry && entry.school_name && <div style={{ fontSize: 11, color: C.textSec, marginTop: 1 }}>{entry.school_name}</div>}
                      </div>
                      {scoreVal !== null && <div style={{ fontSize: 15, fontWeight: isWinner ? 900 : 700, color: scoreColor, minWidth: 18, textAlign: "right" }}>{scoreVal}</div>}
                    </div>
                  );
                };

                // ★エントリー番号が両サイドに入っている場合、公式の組み合わせ表と同じように
                //   番号が若い方を上に表示する（試合データ上のサイドA/Bやスコアの色分けには影響しない、表示順のみ）
                const aNo = dm.sideA?.entry_no != null && dm.sideA?.entry_no !== "" ? Number(dm.sideA.entry_no) : null;
                const bNo = dm.sideB?.entry_no != null && dm.sideB?.entry_no !== "" ? Number(dm.sideB.entry_no) : null;
                const swapOrder = aNo != null && bNo != null && !Number.isNaN(aNo) && !Number.isNaN(bNo) && aNo > bNo;
                const topSide = swapOrder ? "B" : "A";
                const bottomSide = swapOrder ? "A" : "B";

                return (
                  <div key={dm.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 9, color: C.textSec }}>第{idx + 1}試合</span>
                      {(dm.sideA || dm.sideB) && !dm.match_id && (
                        <button
                          style={{ border: "none", background: "none", fontSize: 9.5, color: C.textSec, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                          onClick={(e) => { e.stopPropagation(); openEditingSlot(dm); }}
                        >✏️ 対戦情報を編集</button>
                      )}
                    </div>
                    <div
                      style={{ background: C.white, borderRadius: 10, border: "1px solid " + borderColor, overflow: "hidden", cursor: "pointer" }}
                      onTouchStart={() => startLongPress(dm)}
                      onTouchEnd={cancelLongPress}
                      onTouchMove={cancelLongPress}
                      onMouseDown={() => startLongPress(dm)}
                      onMouseUp={cancelLongPress}
                      onMouseLeave={cancelLongPress}
                      onClick={() => {
                        if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } // ★長押しでシートを開いた場合は通常タップを無視
                        if (startingId) return; // ★作成処理中は他の操作を無視（連打対策）
                        if (dm.match_id) { onOpenMatch(dm.match_id); return; }
                        if (filled) {
                          openSimpleResultModal(dm);
                          return;
                        }
                        openEditingSlot(dm);
                      }}
                    >
                      {(!mi || mi.status === "scheduled") && !hasSimpleResult && (
                        <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 8px 0" }}>
                          <span style={{ fontSize: 8.5, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: startingId === dm.id ? C.orange : hasWithdrawn ? C.redL : C.white, color: startingId === dm.id ? C.white : hasWithdrawn ? C.red : C.textSec, border: startingId === dm.id ? "none" : "1px solid " + (hasWithdrawn ? C.red : C.border) }}>
                            {startingId === dm.id ? "作成中..." : hasWithdrawn ? "棄権" : "予定"}
                          </span>
                        </div>
                      )}
                      {hasSimpleResult && (
                        <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 8px 0" }}>
                          <span style={{ fontSize: 8.5, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: "#f1efff", color: C.purple, border: "1px solid " + C.purple }}>簡易記録</span>
                        </div>
                      )}
                      {sideRow(topSide, true)}
                      {sideRow(bottomSide, false)}
                      {mi && mi.status !== "scheduled" && (
                        <div style={{ padding: "5px 9px", fontSize: 10, color: mi.status === "active" ? C.orange : mi.status === "waiting" ? C.purple : C.textSec, fontWeight: (mi.status === "active" || mi.status === "waiting") ? 700 : 400 }}>
                          {mi.status === "active" ? "🔴 進行中" : mi.status === "waiting" ? "⏳ 待機中" : mi.status === "abandoned" ? "途中終了" : mi.status === "suspended" ? "中断" : isWalkover ? "不戦勝で終了" : "試合終了"}
                        </div>
                      )}
                      {winnerSide && !alreadyAdvanced && !!rounds[rn + 1] && (
                        <button
                          style={{ display: "block", width: "100%", border: "none", background: C.navy, color: C.white, fontSize: 11, fontWeight: 700, padding: "8px 0", cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAdvancingFrom(dm);
                          }}
                        >🏆 勝者を次の試合へ進出</button>
                      )}
                      {winnerSide && alreadyAdvanced && (
                        <div style={{ textAlign: "center", fontSize: 10, color: C.textSec, padding: "6px 0", background: C.gray }}>✓ 次の試合へ進出済み</div>
                      )}
                      {winnerSide && !alreadyAdvanced && !rounds[rn + 1] && (
                        <div style={{ textAlign: "center", fontSize: 10.5, color: C.navy, fontWeight: 700, padding: "6px 0", background: C.accentL }}>🏁 大会終了（{entryLabel(winnerEntry)} 優勝）</div>
                      )}
                      {filled && !dm.match_id && (
                        <button
                          style={{ display: "block", width: "100%", border: "none", borderTop: "1px solid " + C.border, background: C.gray, color: C.textSec, fontSize: 10, fontWeight: 600, padding: "6px 0", cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (startingId) return;
                            if (category === "individual") { startMatch(dm); return; }
                            alert("個々の試合（1複・2複など）を作って詳しくスコアを記録したい場合は、大会画面の「＋」から通常の団体戦試合登録をしてください。");
                          }}
                        >{category === "individual" ? "1点ずつスコアを入力する場合はこちら" : "詳しい試合を作成する場合はこちら"}</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.textSec, marginTop: 4 }}>未定の枠をタップして対戦情報を入力。両サイド決まったらタップすると試合画面が開きます（実際のスコア入力は「第1ゲーム開始」を押すまで始まりません）。作成済みの試合は長押しでコピー・削除ができます。</div>

      {editingSlot && (() => {
        // ★このエントリーが「前の回戦の勝者として進出してきたもの（＝同じdraw_entries.idを
        //   前の回戦の枠と共有している）」かどうかを判定する。共有されている場合、この画面から
        //   編集すると元になった回戦のデータまで書き換わってしまうため、編集を禁止する。
        const isSharedWithEarlierRound = (entryId) => {
          if (!entryId) return false;
          return roundNos.some(rn => {
            if (rn >= editingSlot.round_no) return false;
            return (rounds[rn] || []).some(m => m.side_a_entry_id === entryId || m.side_b_entry_id === entryId);
          });
        };
        const sideALocked = isSharedWithEarlierRound(editingSlot.side_a_entry_id);
        const sideBLocked = isSharedWithEarlierRound(editingSlot.side_b_entry_id);
        return (
          <DrawEntrySheet
            drawMatch={editingSlot}
            tournament={tournament}
            category={category}
            blockLabel={selectedBlock}
            roundLabel={`${editingSlot.round_no}回戦`}
            matchLabel={`第${editingSlot.round_no}回戦`}
            mySchoolName={mySchoolName}
            onClose={closeEditingSlot}
            onSaved={reload}
            prefillSchoolA={copyPrefill?.schoolA}
            prefillSchoolB={copyPrefill?.schoolB}
            sideALocked={sideALocked}
            sideBLocked={sideBLocked}
          />
        );
      })()}

      {simpleResultFor && (
        <Modal onClose={closeSimpleResultModal}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>結果だけ記録</div>
            <button
              style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
              onClick={closeSimpleResultModal}
              aria-label="閉じる"
            >×</button>
          </div>
          <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 16 }}>
            {category === "individual"
              ? "1点ずつのスコアは入力せず、スコアだけ記録します。数字が大きい方が自動的に勝ちになります。あとから1点ずつ入力したくなったら「1点ずつスコアを入力する場合はこちら」から切り替えられます。"
              : "個々の試合は作らず、スコアだけ記録します。数字が大きい方が自動的に勝ちになります。あとから詳しい試合を作りたくなったら、「＋」から通常の団体戦試合登録ができます。"}
          </div>

          <div style={{ fontSize: 11, color: C.textSec, fontWeight: 700, marginBottom: 6, textAlign: "center" }}>スコア（数字が大きい方が自動で勝ちになります）</div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 14, marginBottom: 20 }}>
            {(() => {
              // ★対戦カードと同じ並び順（エントリー番号が若い方を上/左）で表示する。
              const aNo = simpleResultFor.sideA?.entry_no != null && simpleResultFor.sideA?.entry_no !== "" ? Number(simpleResultFor.sideA.entry_no) : null;
              const bNo = simpleResultFor.sideB?.entry_no != null && simpleResultFor.sideB?.entry_no !== "" ? Number(simpleResultFor.sideB.entry_no) : null;
              const swap = aNo != null && bNo != null && !Number.isNaN(aNo) && !Number.isNaN(bNo) && aNo > bNo;
              const leftSide = swap ? "B" : "A";
              const rightSide = swap ? "A" : "B";
              const scoreBlock = (side) => {
                const entry = side === "A" ? simpleResultFor.sideA : simpleResultFor.sideB;
                return (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: 1 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: C.text, textAlign: "center" }}>
                      {entry?.entry_no != null && entry?.entry_no !== "" ? `${entry.entry_no} ` : ""}{entryLabel(entry)}
                    </div>
                    <input
                      type="number" min="0"
                      value={side === "A" ? simpleResultScoreA : simpleResultScoreB}
                      onChange={e => side === "A" ? setSimpleResultScoreA(e.target.value) : setSimpleResultScoreB(e.target.value)}
                      style={{ width: 64, height: 64, border: "1px solid " + C.border, borderRadius: 12, fontSize: 24, fontWeight: 800, textAlign: "center" }}
                    />
                  </div>
                );
              };
              return (
                <>
                  {scoreBlock(leftSide)}
                  <span style={{ fontSize: 20, fontWeight: 800, color: C.textSec, marginTop: 34 }}>－</span>
                  {scoreBlock(rightSide)}
                </>
              );
            })()}
          </div>

          <button
            style={{ width: "100%", padding: 13, borderRadius: 10, background: C.accent, color: C.white, fontWeight: 800, fontSize: 14, border: "none", cursor: "pointer", opacity: savingSimpleResult ? 0.7 : 1 }}
            disabled={savingSimpleResult}
            onClick={handleSaveSimpleResult}
          >{savingSimpleResult ? "保存中..." : "保存する"}</button>

          {simpleResultFor.simple_result_winner && (
            <button
              style={{ width: "100%", padding: 10, marginTop: 8, borderRadius: 10, background: "none", color: C.red, fontWeight: 700, fontSize: 12.5, border: "1px solid " + C.red, cursor: "pointer", opacity: savingSimpleResult ? 0.7 : 1 }}
              disabled={savingSimpleResult}
              onClick={handleClearSimpleResult}
            >この結果を削除する</button>
          )}
        </Modal>
      )}

      {advancingFrom && (() => {
        const winnerEntry = getWinnerEntry(advancingFrom);
        const nextSlots = (rounds[advancingFrom.round_no + 1] || []).slice().sort((a, b) => a.slot_no - b.slot_no);
        return (
          <Modal onClose={() => setAdvancingFrom(null)}>
            <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>どの試合に進出させますか？</div>
                <button
                  style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
                  onClick={() => setAdvancingFrom(null)}
                  aria-label="閉じる"
                >×</button>
              </div>
              <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 14 }}>
                「{entryLabel(winnerEntry)}」を進出させる枠を選んでください
              </div>
              {nextSlots.length === 0 && (
                <div style={{ fontSize: 12.5, color: C.textSec, textAlign: "center", padding: "20px 0" }}>次の回戦がまだ作られていません。</div>
              )}
              {nextSlots.map(slot => (
                <div key={slot.id} style={{ border: "1px solid " + C.border, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ fontSize: 10, color: C.textSec, textAlign: "center", padding: "4px 0", background: C.gray }}>第{slot.slot_no}試合</div>
                  {["A", "B"].map(side => {
                    const cur = side === "A" ? slot.sideA : slot.sideB;
                    return (
                      <div key={side} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 10px", borderTop: side === "B" ? "1px solid " + C.border : "none" }}>
                        <span style={{ fontSize: 12.5, color: cur ? C.text : C.textSec }}>{cur ? entryLabel(cur) : "未定"}</span>
                        {!cur && (
                          <button
                            style={{ fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 99, border: "none", background: C.accent, color: C.white, cursor: "pointer", opacity: advancingId === slot.id ? 0.7 : 1 }}
                            disabled={advancingId === slot.id}
                            onClick={() => advanceWinner(slot.id, side, winnerEntry)}
                          >{advancingId === slot.id ? "処理中..." : "ここに入れる"}</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Modal>
        );
      })()}

      {bulkImportOpen && (
        <Modal onClose={() => !bulkImporting && closeBulkImport()}>
          <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>一覧から一括登録</div>
              <button
                style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
                onClick={() => !bulkImporting && closeBulkImport()}
                aria-label="閉じる"
              >×</button>
            </div>
            <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 10 }}>
              1行に1エントリー、「エントリー番号 [タブ] 学校名 [タブ] 選手1 [タブ] 選手2」の順で貼り付けてください。上から2件ずつペアにして、選んだ回戦の第1試合・第2試合…へ自動で登録されます。
            </div>
            <div style={{ fontSize: 11, color: C.textSec, background: C.gray, borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontFamily: "monospace" }}>
              1　福岡工業　山田 太郎　鈴木 次郎<br/>
              2　久留米商業　田中 一郎　佐藤 健
            </div>

            <label style={{ fontSize: 11, color: C.textSec }}>登録先の回戦</label>
            <select
              value={bulkTargetRound}
              onChange={e => updateBulkTargetRound(Number(e.target.value))}
              style={{ width: "100%", padding: "9px 10px", borderRadius: 8, border: "1px solid " + C.border, fontSize: 13, marginTop: 4, marginBottom: 12 }}
            >
              {roundNos.map(rn => (
                <option key={rn} value={rn}>{rn}回戦（{rounds[rn].length}試合＝{rounds[rn].length * 2}エントリー分）</option>
              ))}
            </select>

            <textarea
              value={bulkText}
              onChange={e => updateBulkText(e.target.value)}
              placeholder={"1\t福岡工業\t山田 太郎\t鈴木 次郎\n2\t久留米商業\t田中 一郎\t佐藤 健\n..."}
              style={{ width: "100%", minHeight: 180, boxSizing: "border-box", border: "1px solid " + C.border, borderRadius: 8, padding: 10, fontSize: 12.5, fontFamily: "monospace", marginBottom: 12 }}
            />

            <button
              style={{ width: "100%", padding: 13, background: `linear-gradient(135deg,${C.accent},#00a066)`, color: C.white, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8, opacity: bulkImporting ? 0.7 : 1 }}
              disabled={bulkImporting}
              onClick={handleBulkImport}
            >{bulkImporting ? "登録中..." : "この内容で登録する"}</button>
            <button
              style={{ width: "100%", padding: 13, background: C.gray, color: C.text, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }}
              disabled={bulkImporting}
              onClick={closeBulkImport}
            >閉じる</button>
          </div>
        </Modal>
      )}

      {longPressMatch && (
        <Modal onClose={() => setLongPressMatch(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>この試合を操作</div>
            <button
              style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
              onClick={() => setLongPressMatch(null)}
              aria-label="閉じる"
            >×</button>
          </div>
          <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 14 }}>
            {entryLabel(longPressMatch.sideA)} vs {entryLabel(longPressMatch.sideB)}
          </div>
          <button
            style={{ width: "100%", padding: 13, background: C.gray, color: C.navy, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}
            onClick={() => { openEditingSlot(longPressMatch); setLongPressMatch(null); }}
          >✏️ 対戦情報を編集</button>
          <button
            style={{ width: "100%", padding: 13, background: C.gray, color: C.navy, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}
            onClick={() => { setCopySourceMatch(longPressMatch); setLongPressMatch(null); }}
          >📋 学校名を別の枠にコピー</button>
          <button
            style={{ width: "100%", padding: 13, background: C.redL, color: C.red, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8 }}
            onClick={() => setConfirmDeleteMatch(longPressMatch)}
          >🗑 この試合を削除</button>
          <button style={{ width: "100%", padding: 13, background: C.gray, color: C.text, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }} onClick={() => setLongPressMatch(null)}>閉じる</button>
        </Modal>
      )}

      {copySourceMatch && (() => {
        const emptySlots = Object.keys(rounds).flatMap(rn =>
          rounds[rn].filter(x => !x.sideA && !x.sideB).map(x => ({ ...x, round_no: Number(rn) }))
        ).sort((a, b) => a.round_no - b.round_no || a.slot_no - b.slot_no);
        return (
          <Modal onClose={() => setCopySourceMatch(null)}>
            <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>コピー先の枠を選んでください</div>
                <button
                  style={{ border: "none", background: "none", fontSize: 20, color: C.textSec, cursor: "pointer", lineHeight: 1, padding: 0, marginLeft: 8, marginRight: 10, flex: "none" }}
                  onClick={() => setCopySourceMatch(null)}
                  aria-label="閉じる"
                >×</button>
              </div>
              <div style={{ fontSize: 11.5, color: C.textSec, marginBottom: 14 }}>
                「{entryLabel(copySourceMatch.sideA)}({copySourceMatch.sideA?.school_name})」vs「{entryLabel(copySourceMatch.sideB)}({copySourceMatch.sideB?.school_name})」の学校名を、選んだ枠にコピーします。選手名とエントリー番号は空欄になるので、そのあと入力してください。
              </div>
              {emptySlots.length === 0 && (
                <div style={{ fontSize: 12.5, color: C.textSec, textAlign: "center", padding: "20px 0" }}>空いている枠がありません。</div>
              )}
              {emptySlots.map(slot => (
                <button
                  key={slot.id}
                  style={{ display: "block", width: "100%", textAlign: "left", border: "1px solid " + C.border, borderRadius: 10, marginBottom: 10, padding: "10px 12px", background: C.white, cursor: "pointer", fontSize: 12.5, color: C.text }}
                  onClick={() => {
                    setCopyPrefill({ schoolA: copySourceMatch.sideA?.school_name || "", schoolB: copySourceMatch.sideB?.school_name || "" });
                    openEditingSlot(slot);
                    setCopySourceMatch(null);
                  }}
                >{slot.round_no}回戦 第{slot.slot_no}試合</button>
              ))}
            </div>
          </Modal>
        );
      })()}

      {confirmDeleteMatch && (
        <Modal onClose={() => setConfirmDeleteMatch(null)}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🗑</div>
            <h3 style={{ fontSize: 16, fontWeight: 800, margin: "8px 0 4px" }}>この試合を削除しますか？</h3>
            <p style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>
              {entryLabel(confirmDeleteMatch.sideA)} vs {entryLabel(confirmDeleteMatch.sideB)}<br/>
              試合はゴミ箱に移動し、24時間以内であれば元に戻せます。枠は再び「予定」の状態に戻ります。
            </p>
            <button
              style={{ width: "100%", padding: 13, background: C.red, color: C.white, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 8, opacity: deletingMatch ? 0.7 : 1 }}
              disabled={deletingMatch}
              onClick={() => handleDeleteMatch(confirmDeleteMatch.match_id, confirmDeleteMatch.id)}
            >{deletingMatch ? "削除中..." : "削除する"}</button>
            <button style={{ width: "100%", padding: 13, background: C.gray, color: C.text, border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer" }} onClick={() => setConfirmDeleteMatch(null)}>キャンセル</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// グループ参加者画面
// ============================================================
function GroupMembersScreen({ onBack }) {
  const [members, setMembers] = useState([]);
  const [myProfile, setMyProfile] = useState(null);
  const [schoolInfo, setSchoolInfo] = useState(null);
  const [mySchoolName, setMySchoolName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const p = await getMyProfile();
      setMyProfile(p);
      if (p?.school_id) {
        const [info, schools] = await Promise.all([
          getSchoolInviteInfo(p.school_id),
          getSchools(),
        ]);
        setSchoolInfo(info);
        const school = schools.find(s => s.id === p.school_id);
        const genderLabel = GENDER_OPTIONS.find(g => g.key === p.gender_category)?.label || "";
        setMySchoolName(school ? `${school.name}（${school.prefecture}・${categoryLabel(school.category)}${genderLabel ? "・"+genderLabel : ""}）` : "");
      }
      const list = await getGroupMembers();
      setMembers(list);
      setLoading(false);
    })();
  }, []);

  const adminId = schoolInfo?.admin_user_id;

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>グループ参加者</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>読み込み中...</div>
        ) : (
          <div style={{ background:C.white,borderRadius:12,padding:14 }}>
            <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`2px solid ${C.navy}`,paddingBottom:6,marginBottom:12 }}>
              <span style={{ fontSize:12,fontWeight:800,color:C.navy }}>{mySchoolName}</span>
              <span style={{ background:C.navy,color:C.white,fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20 }}>{members.length}人</span>
            </div>
            {members.map(m => (
              <div key={m.id} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${C.border}` }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <div style={{ width:36,height:36,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:C.accent,flexShrink:0,overflow:"hidden" }}>
                    {m.avatar_url ? <img src={m.avatar_url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/> : (m.name?.charAt(0) || "?")}
                  </div>
                  <span style={{ fontSize:14,fontWeight:700,color:C.text }}>{m.name}</span>
                </div>
                {m.id === adminId ? (
                  <span style={{ background:"#6366f1",color:C.white,fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20,whiteSpace:"nowrap" }}>👑 管理者</span>
                ) : (
                  <span style={{ background:C.textSec,color:C.white,fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20,whiteSpace:"nowrap" }}>メンバー</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// マスター管理ハブ画面（選手マスター・学校マスターへの入口）
// ============================================================
function MasterScreen({ onNavigate, onRoster, onSchoolAdmin, onGroupMembers, onGoalSettings, onTrash, onProfile, onLogout }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { getMyProfile().then(p=>setIsAdmin(!!p?.is_admin)); }, []);

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>設定</span>
        <div style={{ display:"flex",gap:6 }}>
          <button
            style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:14, padding:"6px 9px", cursor:"pointer" }}
            onClick={onProfile} title="プロフィール"
          >👤</button>
          <button
            style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:11, padding:"6px 10px", cursor:"pointer" }}
            onClick={onLogout}
          >ログアウト</button>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        <div
          style={{ ...S.card, padding:"16px 14px", marginBottom:10, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onGoalSettings}
        >
          <div>
            <div style={{ fontSize:14,fontWeight:700 }}>🎯 目標設定</div>
            <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>1stサーブ確率・レシーブミス率などチーム共通の目標<br/>（編集は管理者専用）</div>
          </div>
          <span style={{ fontSize:16,color:C.textSec }}>→</span>
        </div>
        <div
          style={{ ...S.card, padding:"16px 14px", marginBottom:10, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onRoster}
        >
          <div>
            <div style={{ fontSize:14,fontWeight:700 }}>👥 選手マスター</div>
            <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>自チーム・他チームの選手を登録</div>
          </div>
          <span style={{ fontSize:16,color:C.textSec }}>→</span>
        </div>
        {isAdmin && (
          <div
            style={{ ...S.card, padding:"16px 14px", marginBottom:10, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
            onClick={onSchoolAdmin}
          >
            <div>
              <div style={{ fontSize:14,fontWeight:700 }}>🛠 学校マスター管理</div>
              <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>学校・チームの一覧を管理（管理者専用）</div>
            </div>
            <span style={{ fontSize:16,color:C.textSec }}>→</span>
          </div>
        )}
        <div
          style={{ ...S.card, padding:"16px 14px", marginBottom:10, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onGroupMembers}
        >
          <div>
            <div style={{ fontSize:14,fontWeight:700 }}>👤 グループ参加者</div>
            <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>参加中のメンバーを確認</div>
          </div>
          <span style={{ fontSize:16,color:C.textSec }}>→</span>
        </div>
        <div
          style={{ ...S.card, padding:"16px 14px", cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onTrash}
        >
          <div>
            <div style={{ fontSize:14,fontWeight:700 }}>🗑 ゴミ箱</div>
            <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>削除した大会・試合を確認（24時間以内なら復元可）</div>
          </div>
          <span style={{ fontSize:16,color:C.textSec }}>→</span>
        </div>

        <div style={{ textAlign:"center", marginTop:20, fontSize:11, color:C.textSec }}>v1.5</div>
      </div>
      <NavBar active="master" onNavigate={onNavigate}/>
    </div>
  );
}

// ============================================================
// 動画レビュー画面
// ・画面1：動画を選ぶ／同期する（試合ごとに一度でよい。次回以降は同じファイルを選べば自動復元）
// ・画面2：動画とポイント一覧を見る（普段使う画面）
// ============================================================
function VideoReviewScreen({ onNavigate, matchId, setMatchId, step, setStep, pickedFile, setPickedFile, videoObjectUrl, setVideoObjectUrl }) {
  const [matches, setMatches] = useState(null);
  const [match, setMatch] = useState(null); // getMatch()の詳細（ポイント含む）
  const [matchVideos, setMatchVideos] = useState([]);
  const [activeVideoRow, setActiveVideoRow] = useState(null); // DB上のmatch_videos行（選択中）
  const [anchor, setAnchor] = useState(null); // DB上のvideo_sync_anchors行
  const [curTime, setCurTime] = useState(0);
  const [gameTab, setGameTab] = useState(0);
  const [reviewTab, setReviewTab] = useState("points"); // "points" | "analysis"
  const [saving, setSaving] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false); // ★動画ファイルを選んでから再生準備が整うまでの読み込み中フラグ
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const prevMatchIdRef = useRef(matchId); // ★他のタブに移動して戻ってきた際、同じ試合であれば選択状態を維持するため

  useEffect(() => { getMatches().then(setMatches); }, []);

  useEffect(() => {
    if (!matchId) { setMatch(null); setMatchVideos([]); setActiveVideoRow(null); setAnchor(null); prevMatchIdRef.current = null; return; }
    const isNewSelection = prevMatchIdRef.current !== matchId;
    prevMatchIdRef.current = matchId;
    (async () => {
      let m, vids;
      try {
        [m, vids] = await Promise.all([getMatch(matchId), getMatchVideos(matchId)]);
      } catch (err) {
        alert("試合データの読み込みに失敗しました。もう一度お試しください。\n" + (err.message || err));
        setMatch(null); setMatchVideos([]);
        return;
      }
      setMatch(m);
      setMatchVideos(vids);
      if (isNewSelection) {
        // ★本当に別の試合を選んだ場合だけ、動画の選択状態をリセットする
        setStep("setup");
        setPickedFile(null);
        setVideoObjectUrl(null);
        setActiveVideoRow(null);
      } else if (pickedFile) {
        // ★動画タブを離れてから戻ってきた場合：すでに選んでいたファイルに一致するDB行を復元する
        setActiveVideoRow(vids.find(v => v.file_name === pickedFile.name) ?? null);
      } else {
        setActiveVideoRow(vids[0] ?? null);
      }
    })();
  }, [matchId]);

  // 選択中の動画行が変わったら、同期アンカーを読み込む
  useEffect(() => {
    if (!activeVideoRow) { setAnchor(null); return; }
    getSyncAnchor(activeVideoRow.id).then(setAnchor);
  }, [activeVideoRow?.id]);

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function fmtSize(bytes) {
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(1) + "GB";
    return (bytes / (1024 ** 2)).toFixed(0) + "MB";
  }

  function handlePickFile(file) {
    if (!file) return;
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    setVideoLoading(true); // ★ここから再生準備が整うまで「読み込み中」の表示を出す
    setPickedFile(file);
    setActiveVideoRow(null); // ★別の動画に差し替えた場合、前の動画のDB行を誤って使わないようにリセット
    setAnchor(null);
    const url = URL.createObjectURL(file);
    setVideoObjectUrl(url);
  }
  // ★動画URL（videoObjectUrl）は、動画タブを離れて戻ってくる間も再生を維持したいため、
  //   コンポーネントのアンマウント時には解放しない（解放は上のhandlePickFileで差し替え時にのみ行う）

  // 動画のメタデータ（長さ）が読めたタイミングで、必要ならDBに新規登録する
  async function onVideoMetaLoaded() {
    setVideoLoading(false); // ★読み込み完了
    const dur = Math.round(videoRef.current?.duration || 0);
    if (!activeVideoRow && pickedFile) {
      // ★同じ試合に「同じファイル名・ほぼ同じ長さ」の動画がすでに登録されていれば、
      //   新規行を作らずそれを再利用する（同じ動画を選び直すたびに行が増えるのを防ぐ）
      const existing = matchVideos.find(v =>
        v.file_name === pickedFile.name && Math.abs((v.duration_sec ?? 0) - dur) <= 2
      );
      if (existing) { setActiveVideoRow(existing); return; }

      const row = {
        id: uid(), match_id: matchId, video_source_type: "local",
        video_reference: pickedFile.name, file_name: pickedFile.name, duration_sec: dur,
      };
      try {
        await saveMatchVideo(row);
        setMatchVideos(prev => [...prev, row]);
        setActiveVideoRow(row);
      } catch (e) { console.error(e); alert("動画情報の保存に失敗しました: " + e.message); }
    }
  }

  const firstPoint = match?.games?.[0]?.points?.[0] ?? null;

  async function handleSync() {
    if (!activeVideoRow) { alert("動画の登録が完了していないため同期できません。もう一度動画を選び直してください。"); return; }
    if (!firstPoint) return;
    const videoSec = videoRef.current?.currentTime ?? 0;
    setSaving(true);
    try {
      await saveSyncAnchor(activeVideoRow.id, matchId, {
        pointId: firstPoint.id, gameNo: match.games[0].game_number,
        scoredAt: firstPoint.scored_at, videoSec,
      });
      const fresh = await getSyncAnchor(activeVideoRow.id);
      setAnchor(fresh);
    } catch (e) { console.error(e); alert("同期の保存に失敗しました: " + e.message); }
    setSaving(false);
  }

  function goReview() {
    setStep("review");
    setGameTab(0);
    setReviewTab("points");
  }

  function videoSecForPoint(pt) {
    if (!anchor || !pt.scored_at || !anchor.scored_at) return null;
    const diffSec = (new Date(pt.scored_at).getTime() - new Date(anchor.scored_at).getTime()) / 1000;
    return anchor.video_sec + diffSec;
  }

  function jumpTo(sec) {
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, sec);
  }

  // ---------- 画面1：セットアップ ----------
  if (step === "setup") {
    return (
      <div style={S.page}>
        <div style={S.hdr}>
          <div style={{ color: C.white, fontSize: 16, fontWeight: 800 }}>動画レビュー</div>
          <div style={{ color: "#9fb0d0", fontSize: 11, marginTop: 1 }}>試合動画を選択</div>
        </div>

        <div style={{ padding: 12 }}>
          <div style={S.card}>
            <div style={{ padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.navy, marginBottom: 10 }}>試合を選択</div>
              {matches === null ? (
                <div style={{ fontSize: 13, color: C.textSec }}>読み込み中…</div>
              ) : (
                <select
                  value={matchId ?? ""}
                  onChange={e => setMatchId(e.target.value || null)}
                  style={{ width: "100%", boxSizing: "border-box", padding: "11px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 14, fontWeight: 600, color: C.text, background: C.white }}
                >
                  <option value="">試合を選んでください</option>
                  {matches.map(m => {
                    const aNames = (m.players ?? []).filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/");
                    const bNames = (m.players ?? []).filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/");
                    return (
                      <option key={m.id} value={m.id}>
                        {(m.match_date ?? "").slice(5)} {aNames} vs {bNames}（{m.match_score_a}-{m.match_score_b}）
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          </div>

          {matchId && match && (
            <div style={{ ...S.card, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.navy, marginBottom: 10 }}>📹 試合動画</div>

              {!firstPoint && (
                <div style={{ fontSize: 12, color: C.red, background: C.redL, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  この試合にはまだポイントが記録されていないため、動画と同期できません。
                </div>
              )}

              {firstPoint && !firstPoint.scored_at && (
                <div style={{ fontSize: 12, color: C.textSec, background: C.gray, borderRadius: 8, padding: 10, marginBottom: 10, lineHeight: 1.6 }}>
                  この試合は動画連携前の記録のため、ポイントの時刻がありません。<br/>
                  新しく記録した試合から動画ジャンプができます。
                </div>
              )}

              {!videoObjectUrl && (
                <>
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", boxSizing: "border-box", padding: 16, borderRadius: 12, border: `1.5px dashed ${C.accent}`, background: C.accentL, color: "#00874f", fontSize: 14, fontWeight: 700, textAlign: "center", cursor: "pointer" }}>
                    <input ref={fileInputRef} type="file" accept="video/*" style={{ display: "none" }}
                      onChange={e => handlePickFile(e.target.files[0])} />
                    <div style={{ fontSize: 28, marginBottom: 6 }}>🎬</div>
                    動画ファイルを選ぶ
                    <div style={{ fontSize: 11, color: "#3f9c74", fontWeight: 500, marginTop: 4, lineHeight: 1.6 }}>
                      スマホ内の動画を利用します<br/>動画はアプリへ保存しません
                    </div>
                  </label>
                  {activeVideoRow && (
                    <div style={{ fontSize: 11, color: C.textSec, marginTop: 8, lineHeight: 1.6 }}>
                      前回: {activeVideoRow.file_name}（{fmtTime(activeVideoRow.duration_sec)}）を登録済みです。同じ動画を選ぶと自動で同期状態が復元されます。
                    </div>
                  )}
                </>
              )}

              {videoObjectUrl && (
                <>
                  <video ref={videoRef} src={videoObjectUrl} controls style={{ width: "100%", borderRadius: 12, background: "#000" }}
                    onLoadedMetadata={onVideoMetaLoaded}
                    onTimeUpdate={() => setCurTime(videoRef.current?.currentTime ?? 0)} />
                  {videoLoading && (
                    <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, background: "#fff3e0", border: `1px solid ${C.orange}`, fontSize: 12.5, color: "#c2410c", fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: "2px solid #c2410c", borderTopColor: "transparent", animation: "vr-spin 0.8s linear infinite" }} />
                      動画を読み込んでいます…（大きいファイルは時間がかかることがあります）
                      <style>{"@keyframes vr-spin{to{transform:rotate(360deg);}}"}</style>
                    </div>
                  )}
                  <div style={{ marginTop: 8, padding: 12, borderRadius: 10, background: C.gray, border: `1px solid ${C.border}`, fontSize: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: C.text, display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      ✓ {pickedFile?.name}
                    </div>
                    <div style={{ display: "flex", gap: 14, color: C.textSec, fontSize: 11.5 }}>
                      <span>{videoLoading ? "読み込み中…" : fmtTime(videoRef.current?.duration)}</span>
                      <span>{pickedFile ? fmtSize(pickedFile.size) : ""}</span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11.5, color: C.accent, fontWeight: 700, cursor: "pointer" }}
                      onClick={() => fileInputRef.current?.click()}>
                      動画を変更する
                    </div>
                    <input ref={fileInputRef} type="file" accept="video/*" style={{ display: "none" }}
                      onChange={e => handlePickFile(e.target.files[0])} />
                  </div>

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontSize: 12, color: C.textSec }}>
                    <span>再生位置</span>
                    <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{fmtTime(curTime)}</b>
                  </div>

                  {firstPoint && firstPoint.scored_at && (
                    <button
                      disabled={saving || videoLoading}
                      onClick={handleSync}
                      style={{ width: "100%", boxSizing: "border-box", marginTop: 10, padding: 12, borderRadius: 10, border: "none", fontSize: 13, fontWeight: 800, background: (saving || videoLoading) ? C.border : C.navy, color: "#fff", cursor: (saving || videoLoading) ? "default" : "pointer" }}
                    >
                      {saving ? "保存中…" : videoLoading ? "動画を読み込み中…" : "この位置を1点目として同期する"}
                    </button>
                  )}

                  {firstPoint && firstPoint.scored_at && (
                    <div style={{ marginTop: 10, fontSize: 12, padding: "10px 12px", borderRadius: 10, display: "flex", alignItems: anchor ? "flex-start" : "center", flexDirection: anchor ? "column" : "row", gap: anchor ? 2 : 8, background: anchor ? C.accentL : C.gray, color: anchor ? "#00874f" : C.textSec, fontWeight: anchor ? 700 : 400 }}>
                      {anchor ? (
                        <>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, flexShrink: 0 }}/>
                            同期完了
                          </div>
                          <div style={{ display: "flex", gap: 14, fontWeight: 600, fontSize: 11, marginTop: 2 }}>
                            <span>動画 {fmtTime(anchor.video_sec)}</span>
                            <span>ポイント {anchor.game_no}G {firstPoint.score_a_after}-{firstPoint.score_b_after}</span>
                          </div>
                        </>
                      ) : (
                        "1点目が入った瞬間で一時停止して、上のボタンを押してください"
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <button
            disabled={!anchor || !videoObjectUrl}
            onClick={goReview}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 16, padding: 14, borderRadius: 12, border: "none", fontSize: 15, fontWeight: 800, background: (anchor && videoObjectUrl) ? C.accent : C.border, color: (anchor && videoObjectUrl) ? "#fff" : C.textSec, cursor: (anchor && videoObjectUrl) ? "pointer" : "default" }}
          >
            レビュー開始
          </button>
          {(!anchor || !videoObjectUrl) && (
            <div style={{ textAlign: "center", fontSize: 11, color: C.textSec, marginTop: 6 }}>
              {!matchId ? "まず試合を選んでください"
                : !videoObjectUrl ? "動画ファイルを選んでください"
                : "動画を同期するとレビューを開始できます"}
            </div>
          )}
        </div>

        <NavBar active="video" onNavigate={onNavigate} />
      </div>
    );
  }

  // ---------- 画面2：レビュー ----------
  const games = match?.games ?? [];
  const g = games[gameTab];

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ color: C.white, fontSize: 16, fontWeight: 800 }}>動画レビュー</div>
          <div style={{ color: "#9fb0d0", fontSize: 11, marginTop: 1 }}>
            {(match?.tournament_name || match?.venue || "練習試合")}・{match?.match_score_a}-{match?.match_score_b}
          </div>
        </div>
        <div style={{ color: "#9fb0d0", fontSize: 11, textAlign: "right", lineHeight: 1.4, cursor: "pointer" }} onClick={() => setStep("setup")}>
          ⚙<br/>動画を変更
        </div>
      </div>

      <div style={{ padding: 12 }}>
        <div style={S.card}>
          <video ref={videoRef} src={videoObjectUrl} controls style={{ width: "100%", borderRadius: 12, background: "#000", display: "block" }}
            onTimeUpdate={() => setCurTime(videoRef.current?.currentTime ?? 0)} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", fontSize: 12, color: C.textSec }}>
            <span>再生位置</span>
            <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{fmtTime(curTime)}</b>
          </div>
        </div>

        <div style={{ display: "flex", background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 10 }}>
          {[["points", "ポイント一覧"], ["analysis", "分析"]].map(([key, label]) => (
            <div key={key} onClick={() => setReviewTab(key)}
              style={{ flex: 1, textAlign: "center", padding: 10, fontSize: 12, fontWeight: 700, color: reviewTab === key ? C.accent : C.textSec, borderBottom: reviewTab === key ? `3px solid ${C.accent}` : "3px solid transparent", cursor: "pointer" }}>
              {label}
            </div>
          ))}
        </div>

        {reviewTab === "points" && (
          <div style={{ ...S.card, padding: 14 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 2 }}>
              {games.map((gg, i) => (
                <div key={gg.id} onClick={() => setGameTab(i)}
                  style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700, border: `1.5px solid ${i === gameTab ? C.navy : C.border}`, background: i === gameTab ? C.navy : C.white, color: i === gameTab ? "#fff" : C.textSec, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {gg.game_number}ゲーム目
                </div>
              ))}
            </div>
            {(g?.points ?? []).map(pt => {
              const sec = videoSecForPoint(pt);
              const jumpable = sec !== null;
              return (
                <div key={pt.id} onClick={() => jumpable && jumpTo(sec)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", background: C.gray, borderRadius: 8, marginBottom: 6, cursor: jumpable ? "pointer" : "default", opacity: jumpable ? 1 : 0.55 }}>
                  <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, flexShrink: 0, background: pt.scoring_team === "A" ? C.accent : C.orange }} />
                  <div style={{ fontSize: 12, fontWeight: 800, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap", flexShrink: 0, background: pt.scoring_team === "A" ? C.accentL : "#fff1e6", color: pt.scoring_team === "A" ? "#00874f" : "#c2410c" }}>
                    {pt.score_a_after} - {pt.score_b_after}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                    {pt.play_type && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "#fff", color: C.textSec, border: `1px solid ${C.border}` }}>{getPlayLabel(pt.play_type)}</span>}
                    {pt.result_type && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "#fff", color: C.textSec, border: `1px solid ${C.border}` }}>{getResultLabel(pt.result_type)}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.textSec, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    {jumpable ? fmtTime(sec) : "時刻未記録"}
                  </div>
                  {jumpable && <div style={{ fontSize: 13, flexShrink: 0 }}>▶</div>}
                </div>
              );
            })}
          </div>
        )}

        {reviewTab === "analysis" && (
          <div style={{ ...S.card, padding: "26px 10px", textAlign: "center", fontSize: 12, color: C.textSec, lineHeight: 1.7 }}>
            📊 分析機能は今後追加予定です<br/>（タグの絞り込み・成功率の自動集計など）
          </div>
        )}

        <div style={{ fontSize: 11, color: C.textSec, lineHeight: 1.6, marginTop: 10 }}>
          ※タグ（サーブ／ボレー／決めた／ミス 等）は、スコア入力時にすでに記録している内容をそのまま表示しています。
        </div>
      </div>

      <NavBar active="video" onNavigate={onNavigate} />
    </div>
  );
}

// ============================================================
// 目標設定画面（チーム共通・1セットのみ・管理者専用）
// ============================================================
const DEFAULT_GOALS = {
  firstServe: "70",
  receiveMiss: "10",
  winnerCount: "3",
  errorCount: "2",
  pointDiff: "1",
};

function GoalSettingsScreen({ onBack }) {
  const [schoolId, setSchoolId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [firstServe, setFirstServe] = useState(DEFAULT_GOALS.firstServe);
  const [receiveMiss, setReceiveMiss] = useState(DEFAULT_GOALS.receiveMiss);
  const [winnerCount, setWinnerCount] = useState(DEFAULT_GOALS.winnerCount);
  const [errorCount, setErrorCount] = useState(DEFAULT_GOALS.errorCount);
  const [pointDiff, setPointDiff] = useState(DEFAULT_GOALS.pointDiff);
  const backupRef = useRef(null);

  useEffect(() => {
    (async () => {
      const profile = await getMyProfile();
      setIsAdmin(!!profile?.is_admin);
      if (!profile?.school_id) { setLoading(false); return; }
      setSchoolId(profile.school_id);
      const goals = await getSchoolGoals(profile.school_id);
      if (goals) {
        setFirstServe(goals.goal_first_serve_pct!=null ? String(goals.goal_first_serve_pct) : DEFAULT_GOALS.firstServe);
        setReceiveMiss(goals.goal_receive_miss_pct!=null ? String(goals.goal_receive_miss_pct) : DEFAULT_GOALS.receiveMiss);
        setWinnerCount(goals.goal_winner_count!=null ? String(goals.goal_winner_count) : DEFAULT_GOALS.winnerCount);
        setErrorCount(goals.goal_error_count!=null ? String(goals.goal_error_count) : DEFAULT_GOALS.errorCount);
        setPointDiff(goals.goal_point_diff!=null ? String(goals.goal_point_diff) : DEFAULT_GOALS.pointDiff);
      }
      setLoading(false);
    })();
  }, []);

  function handleEdit() {
    if (!isAdmin) return;
    // 編集開始前の値を保持しておき、キャンセル時に復元できるようにする
    backupRef.current = { firstServe, receiveMiss, winnerCount, errorCount, pointDiff };
    setEditMode(true);
  }

  function handleCancel() {
    if (backupRef.current) {
      setFirstServe(backupRef.current.firstServe);
      setReceiveMiss(backupRef.current.receiveMiss);
      setWinnerCount(backupRef.current.winnerCount);
      setErrorCount(backupRef.current.errorCount);
      setPointDiff(backupRef.current.pointDiff);
    }
    setEditMode(false);
  }

  async function handleSave() {
    if (!schoolId || !isAdmin) return;
    setSaving(true);
    try {
      await updateSchoolMaster(schoolId, {
        goal_first_serve_pct: firstServe===""?null:Number(firstServe),
        goal_receive_miss_pct: receiveMiss===""?null:Number(receiveMiss),
        goal_winner_count: winnerCount===""?null:Number(winnerCount),
        goal_error_count: errorCount===""?null:Number(errorCount),
        goal_point_diff: pointDiff===""?null:Number(pointDiff),
      });
      alert("目標を保存しました");
      setEditMode(false);
    } catch(e) {
      alert("保存に失敗しました: "+(e.message||e));
    } finally {
      setSaving(false);
    }
  }

  const canEditNow = isAdmin && editMode;
  const inputStyle = (disabled) => ({
    width:64, textAlign:"center", border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 4px", fontSize:14, fontWeight:700,
    color: disabled ? C.textSec : C.navy,
    background: disabled ? "#f0f1f3" : C.white,
  });
  const row = (num, label, value, setValue, unit) => (
    <>
      <span style={{ fontSize:12,color:C.text,fontWeight:700 }}><span style={{ color:C.textSec,fontWeight:400,marginRight:4 }}>{num}</span>{label}</span>
      <input style={inputStyle(!canEditNow)} type="number" value={value} disabled={!canEditNow} onChange={e=>setValue(e.target.value)} />
      <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{unit}</span>
    </>
  );

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
        <span style={{ fontSize:18,fontWeight:800,color:C.white }}>目標設定</span>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,padding:"40px 0" }}>読み込み中...</div>
        ) : !schoolId ? (
          <div style={{ textAlign:"center",color:C.textSec,padding:"40px 0" }}>学校情報が未設定のため目標を設定できません</div>
        ) : (
          <>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
              <div style={{ fontSize:20,fontWeight:800 }}>🎯 目標設定</div>
              {isAdmin && !editMode && (
                <button
                  style={{ background:C.navy, color:C.white, border:"none", borderRadius:8, fontSize:12, fontWeight:700, padding:"7px 12px", cursor:"pointer" }}
                  onClick={handleEdit}
                >✏️ 目標値変更</button>
              )}
            </div>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:14 }}>ここで設定した目標は、チーム全選手のスタッツ画面に共通で適用されます</div>
            <div style={{ ...S.card, padding:14, display:"grid", gridTemplateColumns:"1fr 68px 56px", columnGap:8, rowGap:14, alignItems:"center" }}>
              {row("①", "1stサーブ確率", firstServe, setFirstServe, "%以上")}
              {row("②", "レシーブミス率", receiveMiss, setReceiveMiss, "%以下")}
              {row("③", "決めたプレイ回数", winnerCount, setWinnerCount, "回以上")}
              {row("④", "ミスしたプレイ回数", errorCount, setErrorCount, "回以下")}
              {row("⑤", "得点差（決めた−ミス）", pointDiff, setPointDiff, "以上")}
            </div>
            {canEditNow && (
              <>
                <button style={{ ...S.btn(`linear-gradient(135deg,${C.navy},#12213f)`), marginTop:14, width:"100%" }} disabled={saving} onClick={handleSave}>
                  {saving?"保存中...":"保存する"}
                </button>
                <button
                  style={{ ...S.btn(C.white,C.textSec), marginTop:10, width:"100%", border:`1px solid ${C.border}` }}
                  disabled={saving}
                  onClick={handleCancel}
                >キャンセル</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HomeScreen({ onNew, onNewTeamMatch, onOpen, onNavigate, onGoPlayerStats, onProfile, onGoToTournaments, onOpenTournament }) {
  const [allMatches, setAllMatches] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [mySchoolName, setMySchoolName] = useState(""); // ★自チーム同士の練習試合判定用

  useEffect(() => {
    Promise.all([getMatches(), getTournaments()]).then(([matches, tns])=>{
      setAllMatches(matches); setTournaments(tns); setLoading(false);
    });
  }, []);
  useEffect(() => {
    (async () => {
      const p = await getMyProfile();
      setProfile(p);
      if (p?.linked_player_id) {
        const roster = await getPlayerRoster();
        const found = roster.find(r => r.id === p.linked_player_id);
        setLinkedPlayerName(found?.player_name ?? null);
      }
      if (p?.school_id) {
        const schools = await getSchools();
        const s = schools.find(s => s.id === p.school_id);
        if (s) setMySchoolName(s.name);
      }
    })();
  }, []);

  const finished = allMatches.filter(m=>m.status==="finished");
  const wins = finished.filter(m=>m.match_score_a>m.match_score_b).length;
  const recent = allMatches.slice(0,3);

  // ★進行中の試合（記録再開の導線）
  const liveMatch = allMatches.find(m => m.status==="active");

  // ★進行中がない場合に表示する、直近の大会予定（大会単位）
  const todayStr = today();
  const upcomingTournament = !liveMatch
    ? tournaments
        .filter(t => (t.end_date || t.start_date) >= todayStr)
        .sort((a,b) => a.start_date.localeCompare(b.start_date))[0]
    : null;

  // ★成績サマリー：試合数が少ないうちは「集計中」表示に
  const STATS_MIN = 5;
  const isStatsReady = finished.length >= STATS_MIN;
  // ★直近5試合の調子（新しい順）
  const last5 = finished.slice(0, 5).map(m => m.match_score_a > m.match_score_b);

  // ★紐づけ選手（お子さん/自分）の戦績を、この画面で直接計算する
  const linkedMatches = linkedPlayerName ? allMatches.filter(m => ownSideFor(m, linkedPlayerName, mySchoolName)) : [];
  const linkedFinished = linkedMatches.filter(m=>m.status==="finished");
  function linkedIsWin(m) {
    return winForPlayer(m, linkedPlayerName, mySchoolName);
  }
  const linkedWins = linkedFinished.filter(linkedIsWin).length;
  const linkedWinRate = linkedFinished.length>0 ? Math.round(linkedWins/linkedFinished.length*100) : 0;

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>
          {profile?.name ? `${profile.name}さん、こんにちは` : "ホーム"}
        </span>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : (
          <>
            {/* ①進行中の試合カード */}
            {liveMatch && (() => {
              const aP = liveMatch.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
              const bP = liveMatch.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
              const bC = liveMatch.players.find(p=>p.team==="B")?.club_name ?? "";
              return (
                <div style={{ ...S.card, padding:16, marginBottom:14, borderLeft:`4px solid ${C.navy}` }}>
                  <div style={{ fontSize:11,fontWeight:800,color:C.navy,marginBottom:8 }}>記録途中の試合があります</div>
                  <div style={{ fontSize:15,fontWeight:800,color:C.text,marginBottom:2 }}>{aP} vs {bC} {bP}</div>
                  <div style={{ fontSize:12,color:C.textSec,marginBottom:12 }}>
                    {fmtDate(liveMatch.match_date)}{liveMatch.tournament_name ? ` ・ ${liveMatch.tournament_name}` : ""}
                  </div>
                  <button style={{ ...S.btn(C.navy) }} onClick={()=>onOpen(liveMatch.id)}>記録を続ける →</button>
                </div>
              );
            })()}

            {/* ②次の試合予定カード（進行中がない場合のみ、大会基準） */}
            {upcomingTournament && (
              <div
                style={{ ...S.card, padding:16, marginBottom:14, borderLeft:`4px solid ${C.textSec}`, cursor:"pointer" }}
                onClick={()=>onOpenTournament && onOpenTournament(upcomingTournament)}
              >
                <div style={{ fontSize:11,fontWeight:800,color:C.textSec,marginBottom:8 }}>次の試合予定</div>
                <div style={{ fontSize:15,fontWeight:800,color:C.text,marginBottom:2 }}>{upcomingTournament.name}</div>
                <div style={{ fontSize:12,color:C.textSec }}>{fmtDate(upcomingTournament.start_date)}</div>
              </div>
            )}

            {/* ③サマリーカード */}
            <div style={{ ...S.card, padding:16, marginBottom:14 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                <div>
                  <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{finished.length}</div>
                  <div style={{ fontSize:11,color:C.textSec }}>総試合数</div>
                </div>
                <div>
                  {isStatsReady ? (
                    <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{wins}勝{finished.length-wins}敗</div>
                  ) : (
                    <div style={{ fontSize:14,fontWeight:700,color:C.textSec }}>集計中</div>
                  )}
                  <div style={{ fontSize:11,color:C.textSec }}>戦績{!isStatsReady && finished.length>0 ? `（${wins}勝${finished.length-wins}敗）` : ""}</div>
                </div>
                <div>
                  {last5.length>0 ? (
                    <div style={{ display:"flex",justifyContent:"center",gap:4 }}>
                      {last5.map((w,i)=>(
                        <div key={i} style={{ width:16,height:16,borderRadius:"50%",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${w?C.navy:C.border}`,color:w?C.text:C.textSec }}>{w?"勝":"負"}</div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize:14,fontWeight:700,color:C.textSec }}>ー</div>
                  )}
                  <div style={{ fontSize:11,color:C.textSec,marginTop:last5.length>0?6:4 }}>直近{last5.length||5}試合の調子</div>
                </div>
              </div>
            </div>

            <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:14 }} onClick={()=>setShowNewModal(true)}>＋ 新規試合を記録する</button>

            {showNewModal && (
              <Modal onClose={()=>setShowNewModal(false)}>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:32, marginBottom:8 }}>🎾</div>
                  <h3 style={{ fontSize:16, fontWeight:800, marginBottom:16 }}>どちらの試合を記録しますか？</h3>
                  <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:12 }}>
                    <button
                      style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), padding:"14px" }}
                      onClick={()=>{ setShowNewModal(false); onNew(); }}
                    >
                      <div style={{ fontSize:15, fontWeight:700 }}>🎾 個人戦</div>
                      <div style={{ fontSize:11, opacity:0.85, marginTop:2 }}>ダブルス・シングルスの1試合を記録</div>
                    </button>
                    <button
                      style={{ ...S.btn(`linear-gradient(135deg,${C.navy},${C.navyMid})`), padding:"14px" }}
                      onClick={()=>{ setShowNewModal(false); onNewTeamMatch && onNewTeamMatch(); }}
                    >
                      <div style={{ fontSize:15, fontWeight:700 }}>🏆 団体戦</div>
                      <div style={{ fontSize:11, opacity:0.85, marginTop:2 }}>3番手制の団体戦を登録</div>
                    </button>
                    <button
                      style={{ ...S.btn(`linear-gradient(135deg,#6366f1,#4f52d1)`), padding:"14px" }}
                      onClick={()=>{ setShowNewModal(false); onGoToTournaments && onGoToTournaments(); }}
                    >
                      <div style={{ fontSize:15, fontWeight:700 }}>📋 大会から作成</div>
                      <div style={{ fontSize:11, opacity:0.85, marginTop:2 }}>大会に紐づけて試合を記録</div>
                    </button>
                  </div>
                  <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:13 }} onClick={()=>setShowNewModal(false)}>キャンセル</button>
                </div>
              </Modal>
            )}

            {linkedPlayerName && (
              <div style={{ ...S.card, padding:16, marginBottom:14, border:`1px solid ${C.navy}22` }}>
                <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:10 }}>🎾 {linkedPlayerName}さんの戦績</div>
                {linkedFinished.length===0 ? (
                  <>
                    <div style={{ fontSize:12,color:C.textSec,marginBottom:10 }}>まだ試合記録がありません</div>
                    <button style={{ ...S.btn("#f4f6fa"), color:C.navy, border:`1px solid ${C.border}`, fontSize:12, fontWeight:700, padding:9 }} onClick={onNew}>この選手の試合を記録する</button>
                  </>
                ) : (
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                    <div>
                      <div style={{ fontSize:18,fontWeight:800,color:C.navy }}>{linkedFinished.length}</div>
                      <div style={{ fontSize:11,color:C.textSec }}>試合数</div>
                    </div>
                    <div>
                      <div style={{ fontSize:18,fontWeight:800,color:C.accent }}>{linkedWinRate}%</div>
                      <div style={{ fontSize:11,color:C.textSec }}>勝率</div>
                    </div>
                    <div>
                      <div style={{ fontSize:18,fontWeight:800,color:C.navy }}>{linkedWins}勝{linkedFinished.length-linkedWins}敗</div>
                      <div style={{ fontSize:11,color:C.textSec }}>戦績</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              style={{ ...S.btn(C.navy), marginBottom:18, display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}
              onClick={onGoPlayerStats}
            >👥 他の選手の戦績を見る</button>

            <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:8 }}>最近の試合</div>
            {allMatches.length===0 && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>まだ試合記録がありません</div>}
            {recent.map(m=>{
              const aWin = m.match_score_a>m.match_score_b;
              const aP = m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
              const bP = m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
              const bC = m.players.find(p=>p.team==="B")?.club_name??"";
              return (
                <div key={m.id} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                    <span style={{ fontSize:12,fontWeight:700 }}>{m.tournament_name||"試合"}</span>
                    <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(m.match_date)}</span>
                  </div>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <span style={{ fontSize:12,color:C.textSec }}>{aP} vs {bC} {bP}</span>
                    <span style={{ fontSize:14,fontWeight:800,color:m.status==="finished"?(aWin?"#2ecc71":"#f97316"):C.textSec }}>
                      {matchStatusShortLabel(m)}
                    </span>
                  </div>
                </div>
              );
            })}
            {allMatches.length>0 && (
              <button style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:13 }} onClick={()=>onNavigate("list")}>すべての試合を見る →</button>
            )}
          </>
        )}
      </div>
      <NavBar active="home" onNavigate={onNavigate}/>
    </div>
  );
}

// ============================================================
// 団体戦 予定登録画面
// ============================================================
function TeamMatchSetup({ editId, copyId, onSave, onCancel, prefillTournament, prefillDate, prefillVenue, lockTournament, tournamentStartDate, tournamentEndDate }) {
  const [ready, setReady] = useState(!editId && !copyId);
  const [saving, setSaving] = useState(false);
  const [matchDate, setMatchDate] = useState(prefillDate || today());
  const [venue, setVenue] = useState(prefillVenue || "");
  const [tournamentName, setTournamentName] = useState(prefillTournament || "");
  const [round, setRound] = useState("");
  const [myTeamDivision, setMyTeamDivision] = useState("");
  const [opponentName, setOpponentName] = useState("");
  const [opponentDivision, setOpponentDivision] = useState("");
  const [format, setFormat] = useState("best2");
  const [courtNumber, setCourtNumber] = useState("");
  const [isYounger, setIsYounger] = useState(null); // ★デフォルトは未選択（必ず選んでもらう）
  const [showMatchInfo, setShowMatchInfo] = useState(false); // 試合情報の表示/非表示（デフォルト：非表示、個人戦フォームと統一）
  const [schools, setSchools] = useState([]); // SchoolField用（名前リスト、idなし）
  const [schoolsWithId, setSchoolsWithId] = useState([]); // id解決用
  const [venues, setVenues] = useState([]);
  const [mySchoolId, setMySchoolId] = useState(null);
  const [mySchoolName, setMySchoolName] = useState(""); // 表示用
  const [mySchoolInitialized, setMySchoolInitialized] = useState(false); // プロフィール初期化済みフラグ
  const [mySchoolChanging, setMySchoolChanging] = useState(false); // 変更確認ポップ
  const [mySchoolPrefFilter, setMySchoolPrefFilter] = useState(""); // 自チーム側の都道府県フィルタ
  const [existingId, setExistingId] = useState(null);
  // 過去の団体戦から候補を取得
  const [pastTournaments, setPastTournaments] = useState([]);
  const [pastRounds, setPastRounds] = useState([]);
  const [pastCourtNumbers, setPastCourtNumbers] = useState([]);
  const [pastDivisions, setPastDivisions] = useState([]);
  const [oppPrefFilter, setOppPrefFilter] = useState("");

  useEffect(() => {
    Promise.all([getSchools(), getKnownSchools(), getKnownVenues(), getMyProfile(), getTeamMatches()]).then(([sWithId, sForUI, v, p, tms]) => {
      setSchools(sForUI); // SchoolField用（名前リスト）
      setSchoolsWithId(sWithId); // id解決用
      setVenues(v);
      // mySchoolIdの初期化はsWithId（id付き）を使う
      const s = sWithId;
      if (p?.school_id) {
        // 手動変更済みでない場合のみプロフィールの学校で初期化
        setMySchoolInitialized(alreadyInit => {
          if (alreadyInit) return true; // 変更済みなら何もしない
          setMySchoolId(p.school_id);
          const found = s.find(sc => sc.id === p.school_id);
          if (found) setMySchoolName(found.name);
          return true;
        });
      }
      // 過去の団体戦からサジェスト候補を生成
      setPastTournaments([...new Set(tms.map(m=>m.tournament_name).filter(Boolean))]);
      setPastRounds([...new Set(tms.map(m=>m.round).filter(Boolean))]);
      setPastCourtNumbers([...new Set(tms.map(m=>m.court_number).filter(Boolean))]);
      setPastDivisions([...new Set(tms.map(m=>m.my_team_division).filter(Boolean))]);
    });
    if (editId) {
      getTeamMatch(editId).then(tm => {
        if (!tm) { setReady(true); return; }
        setExistingId(tm.id);
        setMatchDate(tm.match_date || today());
        setVenue(tm.venue || "");
        setTournamentName(tm.tournament_name || "");
        setRound(tm.round || "");
        setMyTeamDivision(tm.my_team_division || "");
        setOpponentName(tm.opponent_name || "");
        setOpponentDivision(tm.opponent_division || "");
        setFormat(tm.format || "best2");
        setCourtNumber(tm.court_number || "");
        setIsYounger(tm.is_younger !== false);
        // 編集時：保存済みmy_school_idで名前を復元し、プロフィールによる上書きを防ぐ
        if (tm.my_school_id) {
          setMySchoolId(tm.my_school_id);
          setMySchoolInitialized(true);
          Promise.all([getSchools()]).then(([sc])=>{
            const found = sc.find(s=>s.id===tm.my_school_id);
            if (found) setMySchoolName(found.name);
          });
        }
        setReady(true);
      });
    } else if (copyId) {
      getTeamMatch(copyId).then(tm => {
        if (!tm) { setReady(true); return; }
        // コピー：IDは新規、スコアはクリア
        setMatchDate(today());
        setVenue(tm.venue || "");
        setTournamentName(tm.tournament_name || "");
        setRound(tm.round || "");
        setMyTeamDivision(tm.my_team_division || "");
        setOpponentName(tm.opponent_name || "");
        setOpponentDivision(tm.opponent_division || "");
        setFormat(tm.format || "best2");
        setCourtNumber(tm.court_number || "");
        setIsYounger(tm.is_younger !== false);
        setReady(true);
      });
    }
  }, [editId]);

  const canSave = opponentName.trim() && isYounger !== null;

  async function handleSave() {
    setSaving(true);
    try {
      const id = existingId || uid();
      const tm = {
        id, match_date: matchDate, venue, tournament_name: tournamentName,
        round, my_school_id: mySchoolId, my_team_division: myTeamDivision,
        opponent_name: opponentName.trim(), opponent_division: opponentDivision,
        format, status: existingId ? undefined : "scheduled",
        court_number: courtNumber, is_younger: isYounger,
      };
      await saveTeamMatch(tm);
      onSave(id);
    } catch(e) {
      alert("保存エラー: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  if (!ready) return <div style={S.page}><div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div></div>;

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onCancel}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>🏆 団体戦情報登録{editId ? "（編集）" : ""}</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <span style={{ fontSize:11,fontWeight:700,color:C.navy,letterSpacing:"0.05em" }}>試合情報</span>
            <button
              style={{ background:"#eef0f4", border:"none", borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, color:C.navy, cursor:"pointer" }}
              onClick={() => setShowMatchInfo(v => !v)}
            >
              {showMatchInfo ? "非表示 ▲" : "表示 ▼"}
            </button>
          </div>
          {showMatchInfo && (
          <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,overflow:"visible" }}>
          <FormRow label="大会名">
            {lockTournament ? (
              <div style={{ ...S.inp, display:"flex", justifyContent:"space-between", alignItems:"center", fontWeight:700 }}>
                <span>{tournamentName}</span>
                <span style={{ fontSize:12, color:C.textSec, background:"#e2e5eb", padding:"4px 6px", borderRadius:10, fontWeight:700 }}>🔒</span>
              </div>
            ) : (
              <VenueField value={tournamentName} onChange={setTournamentName} venues={pastTournaments} placeholder="例：○○高校選手権"/>
            )}
          </FormRow>
          <FormRow label="試合日">
            {lockTournament && tournamentStartDate && tournamentEndDate && tournamentStartDate !== tournamentEndDate ? (
              <div>
                <input type="date" style={S.inp} value={matchDate} min={tournamentStartDate} max={tournamentEndDate} onChange={e=>setMatchDate(e.target.value)}/>
                <div style={{ fontSize:10, color:C.textSec, marginTop:4 }}>📅 大会期間（{fmtDate(tournamentStartDate)}〜{fmtDate(tournamentEndDate)}）内から選択できます</div>
              </div>
            ) : lockTournament ? (
              <div style={{ ...S.inp, display:"flex", justifyContent:"space-between", alignItems:"center", fontWeight:700 }}>
                <span>{fmtDate(matchDate)}</span>
                <span style={{ fontSize:10, color:C.textSec, background:"#e2e5eb", padding:"2px 8px", borderRadius:10, fontWeight:700 }}>🔒 大会の日程</span>
              </div>
            ) : (
              <input type="date" style={S.inp} value={matchDate} onChange={e=>setMatchDate(e.target.value)}/>
            )}
          </FormRow>
          <FormRow label="場所 / 会場名">
            <VenueField value={venue} onChange={setVenue} venues={venues}/>
          </FormRow>
          <FormRow label="形式">
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ ...S.togBtn(format==="best2", C.navy), flex:1 }} onClick={()=>setFormat("best2")}>2勝先取</button>
              <button style={{ ...S.togBtn(format==="all3", C.navy), flex:1 }} onClick={()=>setFormat("all3")}>3試合全部</button>
            </div>
          </FormRow>
          </div>
          )}
        </div>

        <FormSec title="チーム情報">
          <FormRow label="自チーム名">
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ ...S.inp, flex:1, background:C.gray, color:C.text, display:"flex", alignItems:"center", minHeight:38 }}>
                {mySchoolName || "（プロフィールから自動入力）"}
              </div>
              <button
                style={{ padding:"8px 12px", borderRadius:8, border:"1px solid "+C.border, background:C.white, color:C.navy, fontSize:12, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}
                onClick={()=>setMySchoolChanging(true)}
              >変更</button>
            </div>
          </FormRow>
          <FormRow label="自チーム区分（任意）">
            <VenueField value={myTeamDivision} onChange={setMyTeamDivision} venues={pastDivisions} placeholder="例：Aチーム"/>
          </FormRow>
          <FormRow label="相手校名（必須）" labelRight={<PrefMiniFilter value={oppPrefFilter} onChange={setOppPrefFilter} options={knownPrefsFrom(schools)} />}>
            <SchoolField value={opponentName} onChange={setOpponentName} schools={schools} placeholder="例：鹿児島実業" prefFilter={oppPrefFilter}/>
          </FormRow>
          <FormRow label="相手チーム区分（任意）">
            <input style={S.inp} placeholder="例：Bチーム" value={opponentDivision} onChange={e=>setOpponentDivision(e.target.value)}/>
          </FormRow>
        </FormSec>

        <FormSec title="試合詳細">
          <FormRow label="何回戦（任意）">
            <RoundField value={round} onChange={setRound} placeholder="例：準々決勝"/>
          </FormRow>
          <FormRow label="コート番号（任意）">
            <VenueField value={courtNumber} onChange={setCourtNumber} venues={pastCourtNumbers} placeholder="例：3番コート"/>
          </FormRow>
          <FormRow label="若番 / 遅番（必須）">
            <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>自チームはトーナメント表のどちら側ですか？</div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              <button style={S.togBtn(isYounger===true, C.navy)} onClick={()=>setIsYounger(true)}>若番</button>
              <button style={S.togBtn(isYounger===false, C.navy)} onClick={()=>setIsYounger(false)}>遅番</button>
            </div>
          </FormRow>
        </FormSec>

        <button
          style={{ ...S.btn(canSave && !saving ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border, canSave && !saving ? C.white : C.textSec), marginTop:8 }}
          disabled={!canSave || saving}
          onClick={handleSave}
        >
          {saving ? "保存中..." : "💾 保存する"}
        </button>
      </div>

      {/* 自チーム変更確認ポップ */}
      {mySchoolChanging && (
        <Modal onClose={()=>{ setMySchoolChanging(false); setMySchoolPrefFilter(""); }}>
          <div>
            <h3 style={{ fontSize:15, fontWeight:800, marginBottom:6 }}>自チームを変更しますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:14 }}>他校の団体戦を記録する場合など、自チームを変更できます。</p>
            <PrefMiniFilter value={mySchoolPrefFilter} onChange={setMySchoolPrefFilter} options={knownPrefsFrom(schools)} />
            <SchoolField
              value={mySchoolName}
              onChange={name => {
                // idを持つschoolsWithIdからidを解決する
                const found = schoolsWithId.find(s => s.name === name);
                if (found) {
                  setMySchoolId(found.id);
                  setMySchoolName(found.name);
                  setMySchoolInitialized(true);
                  setMySchoolChanging(false);
                  setMySchoolPrefFilter("");
                } else {
                  // schoolsWithIdに見つからない場合は名前だけ更新（idはnull）
                  setMySchoolName(name);
                  setMySchoolInitialized(true);
                  setMySchoolChanging(false);
                  setMySchoolPrefFilter("");
                }
              }}
              schools={schools}
              placeholder="学校名を選択"
              prefFilter={mySchoolPrefFilter}
            />
            <div style={{ display:"flex", gap:8, marginTop:14 }}>
              <button style={{ flex:1, padding:10, borderRadius:10, border:"1px solid "+C.border, background:C.white, color:C.text, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>{ setMySchoolChanging(false); setMySchoolPrefFilter(""); }}>キャンセル</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// 団体戦 詳細画面（リアルタイム観戦含む）
// ============================================================
function TeamMatchDetail({ teamMatchId, onBack, onOpenMatch, onNewMatch, onStartMatch, onEdit, onNavigate }) {
  const [tm, setTm] = useState(null);
  const [notFound, setNotFound] = useState(false); // ★削除済みなどで団体戦が見つからない場合
  const [loading, setLoading] = useState(true);
  const [liveActive, setLiveActive] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(Date.now()); // ★最終更新時刻（差分確認・再開ボタン等で使用）
  const [myUserId, setMyUserId] = useState(null);
  const [myUserName, setMyUserName] = useState("");
  const [schoolMap, setSchoolMap] = useState({}); // school_id -> name
  const [matchDetails, setMatchDetails] = useState({});
  const [serveSelectInfo, setServeSelectInfo] = useState(null); // サーブ選択モーダル用
  const [simpleResultFor, setSimpleResultFor] = useState(null); // ★結果だけ記録モーダル用（{orderNum, game, aLabel, bLabel, aPlayers, bPlayers}）
  const [simpleResultScoreA, setSimpleResultScoreA] = useState("");
  const [simpleResultScoreB, setSimpleResultScoreB] = useState("");
  const [simpleResultNamesA, setSimpleResultNamesA] = useState([]); // ★結果だけ記録：自チーム選手名（編集可）
  const [simpleResultNamesB, setSimpleResultNamesB] = useState([]); // ★結果だけ記録：相手選手名（編集可）
  const [simpleResultSaving, setSimpleResultSaving] = useState(false);
  const intervalRef = useRef(null);
  const inactiveRef = useRef(null);
  const lastSignatureRef = useRef(null); // ★変化検知用：前回確認時点の軽量シグネチャ
  const lastChangeAtRef = useRef(Date.now()); // ★実際にデータ変化を検知した時刻（無変化チェックでは更新しない）
  const pollingRef = useRef(false); // ★ポーリングの多重実行防止

  const INACTIVITY_MS = 20 * 60 * 1000; // 20分

  async function loadData({ markAsChanged = true } = {}) {
    // 先に必要な場合だけ団体戦スコアを再集計し、その後で画面表示用データを取得する。
    // 並列実行にすると、再集計前の古いスコアを表示してしまうことがあるため順序を固定する。
    await recalcTeamMatchScore(teamMatchId);
    const [data, schools] = await Promise.all([
      getTeamMatch(teamMatchId),
      getSchools(),
    ]);
    if (!data) { setNotFound(true); setLoading(false); return; }
    // 学校IDマップを作成
    const smap = {};
    (schools || []).forEach(s => { smap[s.id] = s.name; });
    setSchoolMap(smap);
    const matchIds = (data.games || []).filter(g => g.match_id).map(g => g.match_id);
    if (matchIds.length > 0) {
      const { data: matches } = await supabase.from("matches").select("id,match_score_a,match_score_b,status,match_players(id,team,player_name,club_name,order_num)").in("id", matchIds);
      const map = {};
      (matches || []).forEach(m => { map[m.id] = m; });
      setMatchDetails(map);
    }
    // ★不整合データの自動修復：どの番手も実際には開始されていないのに
    // 団体戦全体のstatusだけが"active"のまま残っているケースを検知し、"scheduled"に戻す。
    // （放置すると本当は始まっていない試合でLIVE自動更新が動き続けてしまう）
    if (data.status === "active" && !(data.games || []).some(g => g.status === "active" || g.status === "finished")) {
      await supabase.from("team_matches").update({ status:"scheduled" }).eq("id", teamMatchId).eq("status","active");
      data.status = "scheduled";
    }
    setTm(data);
    setLoading(false);
    if (markAsChanged) {
      lastChangeAtRef.current = Date.now();
    }
    setLastUpdated(Date.now());
    // 今回取得した内容を基準に、次回以降の「変化なし」判定用シグネチャを更新しておく
    lastSignatureRef.current = await getTeamMatchChangeSignature(teamMatchId, matchIds);
  }

  // ★品質改善（フェーズ2）：自動更新のたびに毎回すべて取り直すのではなく、
  // まず軽量な問い合わせで「前回確認時から何か変わったか」だけを確認し、
  // 変化が無ければ重い再取得（loadData／recalcTeamMatchScore）はスキップする。
  async function checkAndMaybeReload() {
    if (pollingRef.current) return false;
    pollingRef.current = true;
    try {
      const matchIds = (tm?.games || []).filter(g => g.match_id).map(g => g.match_id);
      const sig = await getTeamMatchChangeSignature(teamMatchId, matchIds);
      if (sig !== null && lastSignatureRef.current !== null && sig === lastSignatureRef.current) {
        // 変化なし：重い再取得はしない。lastChangeAtRefも更新しないため、
        // 20分間スコア変化がなければ自動更新を停止できる。
        return false;
      }
      await loadData({ markAsChanged: true });
      return true;
    } finally {
      pollingRef.current = false;
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setMyUserId(data.user?.id ?? null);
    });
    getMyProfile().then(p => { setMyUserName(p?.name || ""); });
    loadData();
  }, [teamMatchId]);

  // 自動更新（実際に試合が進行中の時だけポーリングする。予定・終了時は通信しない）
  useEffect(() => {
    if (!liveActive || tm?.status !== "active") return;
    intervalRef.current = setInterval(async () => {
      const now = Date.now();
      if (now - lastChangeAtRef.current > INACTIVITY_MS) {
        setLiveActive(false);
        clearInterval(intervalRef.current);
        return;
      }
      await checkAndMaybeReload();
    }, 10000);
    return () => clearInterval(intervalRef.current);
  }, [liveActive, teamMatchId, tm?.status]);

  if (notFound) {
    return (
      <div style={S.page}>
        <div style={S.hdr}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
            <span style={{ fontSize:17,fontWeight:800,color:C.white }}>団体戦</span>
          </div>
        </div>
        <div style={{ padding:24, textAlign:"center", color:C.textSec }}>
          <div style={{ fontSize:32, marginBottom:10 }}>🗑</div>
          この団体戦は削除されているため表示できません。<br/>試合一覧から最新の状態を確認してください。
        </div>
      </div>
    );
  }
  if (loading || !tm) {
    return <div style={S.page}><div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div></div>;
  }

  const myLabel = [(tm.my_school_id ? schoolMap[tm.my_school_id] : null) || "自チーム", tm.my_team_division].filter(Boolean).join("");
  const oppLabel = [tm.opponent_name, tm.opponent_division].filter(Boolean).join("");
  const isSameSchool = false; // 同校対決は学校ID比較で判定（簡略化）
  const isCreator = tm.created_by === myUserId; // 編集・削除権限用（維持）
  // 番手ごとの操作権限：recorder_idがnull（未ロック）または自分の場合に操作可能
  const canOperateGame = (game) => {
    if (!game) return true; // 未作成は誰でも操作可
    if (!game.recorder_id) return true; // 未ロックは誰でも操作可
    return game.recorder_id === myUserId; // 自分がロック中なら操作可
  };

  // 番手ごとの状態表示
  const gameStatuses = [1,2,3].map(num => {
    const g = (tm.games || []).find(g => g.order_num === num);
    const m = g?.match_id ? matchDetails[g.match_id] : null;
    return { orderNum: num, game: g, match: m };
  });

  const statusLabel = tm.status === "finished"
    ? (tm.my_score > tm.opponent_score ? `🏆 ${tm.my_score}-${tm.opponent_score} 勝利` : tm.my_score < tm.opponent_score ? `❌ ${tm.my_score}-${tm.opponent_score} 敗北` : `${tm.my_score}-${tm.opponent_score} 全試合終了`)
    : tm.status === "active" ? `⏳ ${tm.my_score}-${tm.opponent_score} 進行中` : "📅 予定";

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:17,fontWeight:800,color:C.white,flex:1 }}>{myLabel||"自チーム"} vs {oppLabel||"相手"}</span>
          {isCreator && <button style={{ background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,color:C.white,fontSize:13,padding:"5px 8px",cursor:"pointer" }} onClick={()=>onEdit&&onEdit(tm.id)}>✏️</button>}
        </div>
      </div>

      <div style={{ padding:"12px 14px", paddingBottom:90 }}>
        {/* 試合情報カード */}
        <div style={{ ...S.card, padding:"12px 14px", marginBottom:12 }}>
          <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:4 }}>{tm.tournament_name||"団体戦"}{tm.round ? ` · ${tm.round}` : ""}</div>
          {tm.match_date && <div style={{ fontSize:11,color:C.textSec }}>{fmtDate(tm.match_date)}{tm.venue ? ` · ${tm.venue}` : ""}</div>}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:8 }}>
            <span style={{ fontSize:13,fontWeight:700,color:tm.status==="finished"?(tm.my_score>tm.opponent_score?C.teamA:C.teamB):C.navy }}>{statusLabel}</span>
            <span style={{ fontSize:11,color:C.textSec }}>{tm.format==="best2" ? "2勝先取" : "3試合全部"}</span>
          </div>
        </div>

        {/* ライブ更新バー */}
        {tm.status === "active" && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 14px", background:"#fff3cd", borderRadius:10, marginBottom:12, border:"1px solid #ffd699" }}>
            {liveActive ? (
              <span style={{ fontSize:11,color:"#7a5800",fontWeight:700 }}>🔴 LIVE 差分確認中（変更時のみ再取得）</span>
            ) : (
              <span style={{ fontSize:11,color:"#7a5800",fontWeight:700 }}>⏸ 更新停止中（20分間動きなし）</span>
            )}
            <div style={{ display:"flex", gap:6 }}>
              <button style={{ fontSize:11,padding:"4px 8px",background:C.navy,color:C.white,border:"none",borderRadius:6,cursor:"pointer" }} onClick={()=>{ loadData({ markAsChanged:true }); }}>今すぐ更新</button>
              {!liveActive && <button style={{ fontSize:11,padding:"4px 8px",background:C.accent,color:C.white,border:"none",borderRadius:6,cursor:"pointer" }} onClick={()=>{ setLiveActive(true); setLastUpdated(Date.now()); }}>再開する</button>}
            </div>
          </div>
        )}

        {/* 番手ごとのカード */}
        {gameStatuses.map(({ orderNum, game, match }) => {
          const recorderName = game?.recorder_name;
          const isRecording = game?.status === "active";
          const isFinished = game?.status === "finished";
          const isAbandoned = match?.status === "abandoned";
          const isSuspended = game?.status === "suspended" && !isAbandoned;
          const isWaiting = !game || game.status === "waiting";

          const aPlayers = match?.match_players?.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "";
          const bPlayers = match?.match_players?.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "";

          const resultColor = match?.status === "finished"
            ? (match.match_score_a > match.match_score_b ? C.teamA : C.teamB)
            : C.textSec;

          const canStart = isWaiting || (isSuspended && !isRecording);

          return (
            <div key={orderNum} style={{ ...S.card, marginBottom:10 }}>
              <div style={{ padding:"10px 14px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontSize:13,fontWeight:700,color:C.navy }}>{orderNum}番手</span>
                {isRecording && recorderName && match?.status !== "finished" && (
                  <span style={{ fontSize:11,color:"#dc2626",fontWeight:700,background:"#fdecea",padding:"2px 8px",borderRadius:20 }}>🔴 {recorderName} 記録中</span>
                )}
                {(isFinished || match?.status === "finished") && <span style={{ fontSize:11,color:C.accent,fontWeight:700 }}>✅ 終了</span>}
                {isSuspended && match?.status !== "finished" && <span style={{ fontSize:11,color:C.textSec,fontWeight:700 }}>中断 {match?.match_score_a}-{match?.match_score_b}</span>}
                {isAbandoned && <span style={{ fontSize:11,color:C.textSec,fontWeight:700 }}>途中終了 {match?.match_score_a}-{match?.match_score_b}</span>}
              </div>
              <div style={{ padding:"10px 14px" }}>
                {aPlayers || bPlayers ? (
                  <>
                    <div style={{ fontSize:12, color:C.text, fontWeight:700, marginBottom:2 }}>{(tm.my_school_id ? schoolMap[tm.my_school_id] : null) || "自チーム"}{tm.my_team_division ? `（${tm.my_team_division}）` : ""}: {aPlayers || "未登録"}</div>
                    <div style={{ fontSize:12, color:C.text, fontWeight:700, marginBottom:8 }}>{tm.opponent_name || "相手"}{tm.opponent_division ? `（${tm.opponent_division}）` : ""}: {bPlayers || "未登録"}</div>
                    {/* ペア登録済みで未開始 → 試合開始前 */}
                    {isWaiting && (
                      <div style={{ fontSize:11, color:C.textSec, marginBottom:8, padding:"4px 10px", background:"#f0f0f0", borderRadius:8, display:"inline-block" }}>試合開始前</div>
                    )}
                    {match && !isWaiting && (
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:12, marginBottom:8 }}>
                        <span style={{ fontSize:22,fontWeight:900,color:match.match_score_a>match.match_score_b?C.teamA:C.textSec }}>{match.match_score_a}</span>
                        <span style={{ fontSize:14,color:C.textSec }}>-</span>
                        <span style={{ fontSize:22,fontWeight:900,color:match.match_score_b>match.match_score_a?C.teamB:C.textSec }}>{match.match_score_b}</span>
                      </div>
                    )}
                    {(isFinished || isSuspended || isAbandoned || isRecording) && game?.match_id && (
                      <div style={{ display:"flex", gap:8 }}>
                        <button style={{ ...S.btn("#f0f0f0"), color:C.navy, fontSize:12, padding:"8px", flex:1 }} onClick={()=>onOpenMatch && onOpenMatch(game.match_id)}>
                          📋 スコア詳細を見る
                        </button>
                        {isFinished && (
                          <button
                            style={{ ...S.btn("#f0f0f0"), color:C.textSec, fontSize:12, padding:"8px", flex:1 }}
                            onClick={async ()=>{
                              const { data: gamesData } = await supabase.from("games").select("id, points(id)").eq("match_id", game.match_id);
                              const hasPoints = (gamesData||[]).some(g => (g.points||[]).length>0);
                              const msg = hasPoints
                                ? "すでに記録されたポイントがすべて消えます。ポイントから記録し直しますか？"
                                : "スコアをリセットして、ポイントから記録し直しますか？";
                              if (!window.confirm(msg)) return;
                              try {
                                await resetMatchToUnrecorded(game.match_id);
                                await updateTeamMatchGame(game.id, { status:"waiting", recorder_id:null, recorder_name:null });
                                await loadData({ markAsChanged:true });
                              } catch(e) {
                                alert("エラー: " + (e.message || e));
                              }
                            }}
                          >
                            🎾 点数から記録し直す
                          </button>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize:12,color:C.textSec,marginBottom:8 }}>ペア未登録</div>
                )}
                {canOperateGame(game) && (
                  <>
                    {/* ペア登録済みで未開始 → 試合開始ボタン（選び直しではなく直接開始） */}
                    {isWaiting && (aPlayers || bPlayers) && game?.match_id && (
                      <div style={{ display:"flex", gap:8, marginTop:8 }}>
                        <button
                          style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13, flex:1 }}
                          onClick={async ()=>{
                            const { data: matchData } = await supabase.from("matches").select("id,match_players(team,player_name,order_num)").eq("id", game.match_id).single();
                            setServeSelectInfo({ matchData, orderNum, game });
                          }}
                        >
                          🎾 試合開始
                        </button>
                        <button
                          style={{ ...S.btn("#f4f6fa"), color:C.navy, border:`1px solid ${C.border}`, fontSize:13, flex:1 }}
                          onClick={()=>{
                            const aP = (match?.match_players||[]).filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num);
                            const bP = (match?.match_players||[]).filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num);
                            setSimpleResultFor({ orderNum, game, aLabel:aPlayers||"自チーム", bLabel:bPlayers||"相手", aPlayers:aP, bPlayers:bP });
                            setSimpleResultScoreA(""); setSimpleResultScoreB("");
                            setSimpleResultNamesA(aP.map(p=>p.player_name));
                            setSimpleResultNamesB(bP.map(p=>p.player_name));
                          }}
                        >
                          📝 結果だけ記録
                        </button>
                      </div>
                    )}
                    {/* ペア未登録 → ペア登録して試合開始 */}
                    {(isWaiting && !(aPlayers || bPlayers)) && (
                      <button
                        style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13, marginTop:0 }}
                        onClick={()=>onNewMatch && onNewMatch(tm, orderNum, game)}
                      >
                        🎾 ペアを登録して試合開始
                      </button>
                    )}
                    {isSuspended && (
                      <button
                        style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13, marginTop:8 }}
                        onClick={async ()=>{
                          const { data: matchData } = await supabase.from("matches").select("id,match_players(team,player_name,order_num)").eq("id", game.match_id).single();
                          setServeSelectInfo({ matchData, orderNum, game });
                        }}
                      >
                        🎾 試合を再開する
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <NavBar active="list" onNavigate={onNavigate}/>

      {/* サーブ選択モーダル */}
      {serveSelectInfo && (() => {
        const { matchData, orderNum, game } = serveSelectInfo;
        const aP = (matchData?.match_players||[]).filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "自チーム";
        const bP = (matchData?.match_players||[]).filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "相手チーム";
        return (
          <Modal onClose={()=>setServeSelectInfo(null)}>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
              <h3 style={{ fontSize:16, fontWeight:800, marginBottom:4 }}>最初のサーブを選択</h3>
              <p style={{ fontSize:12, color:C.textSec, marginBottom:16 }}>どちらがサーブから始めますか？</p>
              <div style={{ display:"flex", gap:10, marginBottom:12 }}>
                <button style={{ flex:1, padding:"14px 8px", borderRadius:12, border:`2px solid ${C.teamA}`, background:"transparent", color:C.teamA, fontWeight:800, fontSize:13, cursor:"pointer" }} onClick={()=>{ setServeSelectInfo(null); onStartMatch && onStartMatch(matchData.id, orderNum, game, "A"); }}>
                  <div>{aP}</div><div style={{ fontSize:11, opacity:0.8 }}>（サーブ）</div>
                </button>
                <button style={{ flex:1, padding:"14px 8px", borderRadius:12, border:`2px solid ${C.orange}`, background:"transparent", color:C.orange, fontWeight:800, fontSize:13, cursor:"pointer" }} onClick={()=>{ setServeSelectInfo(null); onStartMatch && onStartMatch(matchData.id, orderNum, game, "B"); }}>
                  <div>{bP}</div><div style={{ fontSize:11, opacity:0.8 }}>（サーブ）</div>
                </button>
              </div>
              <button style={{ width:"100%", padding:12, borderRadius:10, border:`1px solid ${C.border}`, background:C.gray, color:C.textSec, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setServeSelectInfo(null)}>キャンセル</button>
            </div>
          </Modal>
        );
      })()}

      {/* ★結果だけ記録モーダル（2面展開などでポイントを付けられない時に、ゲームカウントだけ記録する） */}
      {simpleResultFor && (
        <Modal onClose={()=>setSimpleResultFor(null)}>
          <div>
            <div style={{ fontSize:15, fontWeight:800, marginBottom:4 }}>{simpleResultFor.orderNum}番手・結果だけ記録</div>
            <div style={{ fontSize:11, color:C.textSec, marginBottom:16 }}>ポイントを記録せず、ゲームカウントだけ入力します</div>

            {(simpleResultFor.aPlayers?.length>0 || simpleResultFor.bPlayers?.length>0) && (
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>選手名（必要であれば修正できます）</div>
                {simpleResultFor.aPlayers?.map((p,i)=>(
                  <input key={p.id} value={simpleResultNamesA[i]??""} onChange={e=>setSimpleResultNamesA(prev=>{ const next=[...prev]; next[i]=e.target.value; return next; })}
                    style={{ width:"100%", padding:"7px 9px", borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, marginBottom:6, color:C.text, boxSizing:"border-box" }} placeholder="自チーム選手名" />
                ))}
                {simpleResultFor.bPlayers?.map((p,i)=>(
                  <input key={p.id} value={simpleResultNamesB[i]??""} onChange={e=>setSimpleResultNamesB(prev=>{ const next=[...prev]; next[i]=e.target.value; return next; })}
                    style={{ width:"100%", padding:"7px 9px", borderRadius:8, border:`1px solid ${C.border}`, fontSize:13, marginBottom:6, color:C.text, boxSizing:"border-box" }} placeholder="相手選手名" />
                ))}
              </div>
            )}

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
              <div style={{ flex:1, textAlign:"center" }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.teamA, marginBottom:6 }}>{simpleResultFor.aLabel}</div>
                <input type="number" inputMode="numeric" value={simpleResultScoreA} onChange={e=>setSimpleResultScoreA(e.target.value)}
                  style={{ width:"100%", textAlign:"center", fontSize:24, fontWeight:800, padding:"10px 4px", borderRadius:10, border:`2px solid ${C.teamA}`, color:C.teamA }} />
              </div>
              <div style={{ fontSize:18, color:C.textSec, marginTop:24 }}>-</div>
              <div style={{ flex:1, textAlign:"center" }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.teamB, marginBottom:6 }}>{simpleResultFor.bLabel}</div>
                <input type="number" inputMode="numeric" value={simpleResultScoreB} onChange={e=>setSimpleResultScoreB(e.target.value)}
                  style={{ width:"100%", textAlign:"center", fontSize:24, fontWeight:800, padding:"10px 4px", borderRadius:10, border:`2px solid ${C.teamB}`, color:C.teamB }} />
              </div>
            </div>
            <button
              style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginTop:14 }}
              disabled={simpleResultSaving || simpleResultScoreA==="" || simpleResultScoreB==="" || simpleResultScoreA===simpleResultScoreB}
              onClick={async ()=>{
                const a = parseInt(simpleResultScoreA,10), b = parseInt(simpleResultScoreB,10);
                if (isNaN(a) || isNaN(b) || a<0 || b<0) { alert("正しいゲームカウントを入力してください"); return; }
                if (a===b) { alert("同点にはできません（勝敗がつく数字を入力してください）"); return; }
                setSimpleResultSaving(true);
                try {
                  // ★選手名が編集されていれば、スコア保存の前に反映する
                  const nameUpdates = [
                    ...(simpleResultFor.aPlayers||[]).map((p,i)=>({ p, name: simpleResultNamesA[i] })),
                    ...(simpleResultFor.bPlayers||[]).map((p,i)=>({ p, name: simpleResultNamesB[i] })),
                  ].filter(({p,name}) => name && name.trim() && name.trim() !== p.player_name);
                  for (const { p, name } of nameUpdates) {
                    const { error: nameErr } = await supabase.from("match_players").update({ player_name: name.trim() }).eq("id", p.id);
                    if (nameErr) throw nameErr;
                  }
                  await supabase.from("matches").update({ match_score_a:a, match_score_b:b, status:"finished" }).eq("id", simpleResultFor.game.match_id);
                  await updateTeamMatchGame(simpleResultFor.game.id, { status:"finished" });
                  setSimpleResultFor(null);
                  await loadData({ markAsChanged:true });
                } catch(e) {
                  alert("保存エラー: " + (e.message || e));
                } finally {
                  setSimpleResultSaving(false);
                }
              }}
            >{simpleResultSaving ? "保存中..." : "この結果で確定する"}</button>
            <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:13, marginTop:8 }} onClick={()=>setSimpleResultFor(null)}>キャンセル</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// 団体戦 番手ペア登録→試合開始（v1.0のMatchSetupFormを流用）
// ============================================================
function TeamMatchGameSetupWrapper({ teamMatchId, orderNum, onSave, onSavePairOnly, onCancel }) {
  const [tm, setTm] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getTeamMatch(teamMatchId).then(data => {
      setTm(data);
      setReady(true);
    });
  }, [teamMatchId]);

  if (!ready) return <div style={S.page}><div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div></div>;

  const orderLabel = ["1番手","2番手","3番手"][orderNum-1] || `${orderNum}番手`;

  return (
    <MatchSetup
      sourceMatchId={null}
      editMatchId={null}
      initialMatchType="tournament"
      headerLabel={`🏆 団体戦 ${orderLabel} ペア登録`}
      prefillTournament={tm?.tournament_name || ""}
      prefillRound={tm?.round || ""}
      prefillVenue={tm?.venue || ""}
      prefillDate={tm?.match_date || ""}
      prefillOpponent={tm?.opponent_name || ""}
      prefillIsYounger={tm?.is_younger !== false}
      isTeamMatchGame={true}
      teamMatchMyDivision={tm?.my_team_division || ""}
      teamMatchOppDivision={tm?.opponent_division || ""}
      teamMatchMySchoolId={tm?.my_school_id || null}
      onScheduled={null}
      onSave={onSave}
      onSavePairOnly={onSavePairOnly}
      onCancel={onCancel}
    />
  );
}

// ============================================================
// 統計画面（複数試合をまたいだ分析）
// ============================================================
const STATS_FILTER_STORAGE_KEY = "statsFilterPrefsV1";
function loadStatsFilterPrefs() {
  try {
    const raw = localStorage.getItem(STATS_FILTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveStatsFilterPrefs(prefs) {
  try { localStorage.setItem(STATS_FILTER_STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
}
const STATS_CAT_LABELS = { all: "すべて", tournament: "大会", team: "団体戦", individual: "個人戦" };
const STATS_PERIOD_LABELS = { all: "全期間", month1: "直近1ヶ月", month3: "直近3ヶ月" };

// ============================================================
// 個人分析画面：①選手選択 → ②試合選択 → ③分析結果
// 何も設定していない時は「自分（またはお子さん）・直近5試合」をデフォルト表示する
// ============================================================
function PersonalAnalysisScreen({ onNavigate, onOpenTeamStats }) {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState([]);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [mySchoolName, setMySchoolName] = useState("");
  const [allMatches, setAllMatches] = useState([]); // 一覧用の軽量データ

  const [mode, setMode] = useState("results"); // results | wizardPlayer | wizardMatches
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedSchoolName, setSelectedSchoolName] = useState(""); // 空なら自チーム
  const [schoolPickerOpen, setSchoolPickerOpen] = useState(false);
  const [schoolSearch, setSchoolSearch] = useState("");
  const [teamSearch, setTeamSearch] = useState(""); // 選手検索キーワード

  const [selectSubTab, setSelectSubTab] = useState("period"); // period | tournament | individual | all
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [selectedTournaments, setSelectedTournaments] = useState([]);
  const [selectedMatchIds, setSelectedMatchIds] = useState([]);

  // 期間タブのカレンダーUI用
  const [calFilterMode, setCalFilterMode] = useState("range"); // day | range | month
  const [calDay, setCalDay] = useState(null);
  const [calRangeStart, setCalRangeStart] = useState(null);
  const [calRangeEnd, setCalRangeEnd] = useState(null);
  const [calRangeStep, setCalRangeStep] = useState("start");
  const [calMonth, setCalMonth] = useState(null);
  const [calViewYear, setCalViewYear] = useState(new Date().getFullYear());
  const [calViewMonth, setCalViewMonth] = useState(new Date().getMonth());
  const [calMonthViewYear, setCalMonthViewYear] = useState(new Date().getFullYear());

  const [resultMatches, setResultMatches] = useState([]); // 詳細データ込みの試合（分析対象）
  const [resultLoading, setResultLoading] = useState(false);
  const [resultCondLabel, setResultCondLabel] = useState("");
  const [hasLoadedDefault, setHasLoadedDefault] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, rosterList, list] = await Promise.all([getMyProfile(), getPlayerRoster(), getMatches()]);
      setRoster(rosterList);
      setAllMatches(list);
      let linked = null;
      if (p?.linked_player_id) {
        const found = rosterList.find(r => r.id === p.linked_player_id);
        linked = found?.player_name ?? null;
        setLinkedPlayerName(linked);
      }
      if (p?.school_id) {
        const schools = await getSchools();
        const s = schools.find(s => s.id === p.school_id);
        if (s) setMySchoolName(s.name);
      }
      setSelectedPlayer(linked || rosterList.find(r => r.is_own_team !== false)?.player_name || null);
      setLoading(false);
    })();
  }, []);

  const effectiveSchoolName = selectedSchoolName || mySchoolName;
  const isOwnSchool = effectiveSchoolName === mySchoolName;
  const ownRoster = roster.filter(r => r.is_own_team !== false);
  // 選択中の学校に応じた選手候補（自チームなら選手マスター、それ以外は試合記録から拾った名前）
  const rosterForSchool = isOwnSchool
    ? ownRoster.map(r => ({ id: r.id, player_name: r.player_name }))
    : Array.from(new Set(
        allMatches.flatMap(m => m.players.filter(p => p.club_name && p.club_name.trim() === effectiveSchoolName.trim()).map(p => p.player_name))
      )).map(name => ({ id: name, player_name: name }));
  // 候補となる学校名（自チーム＋これまで対戦した相手校）
  const knownSchoolNames = Array.from(new Set(
    [mySchoolName, ...allMatches.flatMap(m => m.players.map(p => p.club_name))].filter(Boolean)
  ));
  const playerMatches = selectedPlayer
    ? allMatches.filter(m => m.status === "finished" && ownSideFor(m, selectedPlayer, effectiveSchoolName))
    : [];

  async function loadResults(matchSummaries, condLabel) {
    setResultLoading(true);
    setResultCondLabel(condLabel);
    const full = await getFullMatchesByIds(matchSummaries.map(m => m.id));
    full.sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
    setResultMatches(full);
    setResultLoading(false);
    setMode("results");
  }

  // 初回表示：条件未設定なら「直近5試合」を自動で読み込む
  useEffect(() => {
    if (!loading && selectedPlayer && !hasLoadedDefault) {
      setHasLoadedDefault(true);
      const recent5 = [...playerMatches].sort((a,b)=> new Date(b.match_date)-new Date(a.match_date)).slice(0,5);
      loadResults(recent5, "直近5試合");
    }
    // eslint-disable-next-line
  }, [loading, selectedPlayer]);

  if (loading) {
    return (
      <div style={{ minHeight:"100vh", background:C.gray, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" }}>
        <div style={{ background:C.navy, color:C.white, padding:16 }}>
          <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
        </div>
        <div style={{ padding:14 }}>
          <div style={{ display:"flex", background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:3, marginBottom:12 }}>
            <div style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, background:C.navy, color:"#fff" }}>個人分析</div>
            <div style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, color:C.textSec }}>チーム統計</div>
          </div>
          <div style={{ padding:40, textAlign:"center", color:C.textSec }}>読み込み中...</div>
        </div>
      </div>
    );
  }

  // ============ ① 選手選択 ============
  if (mode === "wizardPlayer") {
    // 学校を変更する（検索）画面
    if (schoolPickerOpen) {
      const filteredSchools = knownSchoolNames.filter(n => !schoolSearch.trim() || n.toLowerCase().includes(schoolSearch.trim().toLowerCase()));
      return (
        <div style={{ minHeight:"100vh", background:C.gray, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" }}>
          <div style={{ background:C.navy, color:C.white, padding:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ cursor:"pointer", fontSize:18 }} onClick={()=>setSchoolPickerOpen(false)}>←</span>
              <div>
                <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
                <div style={{ fontSize:11, color:"#b9c2d6" }}>チームを選択</div>
              </div>
            </div>
          </div>
          <div style={{ padding:14 }}>
            <div style={{ display:"flex", alignItems:"center", background:C.white, border:`1px solid ${C.navy}`, borderRadius:10, padding:"9px 12px", marginBottom:10, fontSize:13, gap:6 }}>
              🔍<input value={schoolSearch} onChange={e=>setSchoolSearch(e.target.value)} placeholder="学校名・チーム名で検索" style={{ flex:1, border:"none", outline:"none", fontSize:13, background:"transparent" }} autoFocus />
            </div>
            <div style={S.card}>
              {filteredSchools.length===0 && <div style={{ padding:16, textAlign:"center", color:C.textSec, fontSize:12 }}>見つかりません</div>}
              {filteredSchools.map(name => (
                <div key={name} onClick={()=>{
                  setSelectedSchoolName(name === mySchoolName ? "" : name);
                  setSelectedPlayer(null);
                  setSchoolSearch(""); setSchoolPickerOpen(false);
                }} style={{ display:"flex", alignItems:"center", gap:8, padding:"12px 14px", borderBottom:`1px solid ${C.border}`, cursor:"pointer" }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, flex:1 }}>{name}</div>
                  {name===mySchoolName && <span style={{ fontSize:9.5,color:C.accent,background:C.accentL,padding:"2px 7px",borderRadius:6 }}>自チーム</span>}
                </div>
              ))}
            </div>
            <div style={{ fontSize:11, color:C.textSec, padding:"6px 4px" }}>これまで対戦した相手チームも候補に出てきます。選ぶとその学校の選手一覧に切り替わります。</div>
          </div>
        </div>
      );
    }

    const filteredRoster = rosterForSchool.filter(p => !teamSearch.trim() || p.player_name.toLowerCase().includes(teamSearch.trim().toLowerCase()));
    return (
      <div style={{ minHeight:"100vh", background:C.gray, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" }}>
        <div style={{ background:C.navy, color:C.white, padding:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ cursor:"pointer", fontSize:18 }} onClick={()=>setMode("results")}>←</span>
            <div>
              <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
              <div style={{ fontSize:11, color:"#b9c2d6" }}>選手を選択</div>
            </div>
          </div>
        </div>
        <div style={{ padding:14 }}>
          <div style={{ fontSize:11.5, fontWeight:700, color:C.text, marginBottom:6 }}>チーム・学校</div>
          <div onClick={()=>setSchoolPickerOpen(true)} style={{ ...S.card, padding:"12px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
            <div>
              <div style={{ fontSize:14, fontWeight:800, color:C.navy }}>{effectiveSchoolName || "（未設定）"}</div>
              <div style={{ fontSize:10.5, color:C.textSec, marginTop:1 }}>{isOwnSchool ? "自分の所属チーム（デフォルト）" : "相手チーム"}</div>
            </div>
            <div style={{ fontSize:11, color:C.accent, fontWeight:700 }}>変更する ›</div>
          </div>

          <div style={{ display:"flex", alignItems:"center", background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:"9px 12px", marginBottom:10, fontSize:13, gap:6 }}>
            🔍<input value={teamSearch} onChange={e=>setTeamSearch(e.target.value)} placeholder="選手名で検索" style={{ flex:1, border:"none", outline:"none", fontSize:13, background:"transparent" }} />
          </div>
          <div style={S.card}>
            {filteredRoster.length===0 && <div style={{ padding:16, textAlign:"center", color:C.textSec, fontSize:12 }}>選手が見つかりません</div>}
            {filteredRoster.map(p => (
              <div key={p.id} onClick={()=>{ setSelectedPlayer(p.player_name); setMode("wizardMatches"); }}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", borderBottom:`1px solid ${C.border}`, cursor:"pointer" }}>
                <div style={{ width:34,height:34,borderRadius:"50%",background:C.accentL,color:C.accent,fontWeight:800,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{p.player_name[0]}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13.5, fontWeight:700, color:C.text }}>{p.player_name}{p.player_name===linkedPlayerName && <span style={{ fontSize:9.5,color:C.purple,background:"#eef0fe",padding:"2px 7px",borderRadius:6,marginLeft:6 }}>自分</span>}</div>
                  <div style={{ fontSize:10.5, color:C.textSec, marginTop:1 }}>{effectiveSchoolName}</div>
                </div>
                <div style={{ width:19,height:19,borderRadius:"50%",border:`2px solid ${p.player_name===selectedPlayer?C.accent:C.border}`,background:p.player_name===selectedPlayer?C.accent:"transparent" }}/>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ============ ② 試合選択 ============
  if (mode === "wizardMatches") {
    const tournamentNames = Array.from(new Set(playerMatches.map(m=>m.tournament_name).filter(Boolean)));
    let candidateMatches = playerMatches;
    if (selectSubTab === "period" && (periodStart || periodEnd)) {
      candidateMatches = candidateMatches.filter(m => {
        if (!m.match_date) return false;
        if (periodStart && m.match_date < periodStart) return false;
        if (periodEnd && m.match_date > periodEnd) return false;
        return true;
      });
    } else if (selectSubTab === "tournament" && selectedTournaments.length > 0) {
      candidateMatches = candidateMatches.filter(m => selectedTournaments.includes(m.tournament_name));
    } else if (selectSubTab === "individual") {
      candidateMatches = candidateMatches.filter(m => selectedMatchIds.includes(m.id));
    }
    const sortedForList = [...playerMatches].sort((a,b)=> new Date(b.match_date)-new Date(a.match_date));

    const condLabelFor = () => {
      if (selectSubTab === "all") return "すべて";
      if (selectSubTab === "period") return (periodStart||periodEnd) ? `${periodStart||"…"}〜${periodEnd||"…"}` : "期間未指定";
      if (selectSubTab === "tournament") return selectedTournaments.length ? selectedTournaments.join("・") : "大会未選択";
      return `個別選択（${selectedMatchIds.length}件）`;
    };

    return (
      <div style={{ minHeight:"100vh", background:C.gray, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" }}>
        <div style={{ background:C.navy, color:C.white, padding:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ cursor:"pointer", fontSize:18 }} onClick={()=>setMode("wizardPlayer")}>←</span>
            <div>
              <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
              <div style={{ fontSize:11, color:"#b9c2d6" }}>{selectedPlayer}さんの試合を選択</div>
            </div>
          </div>
        </div>
        <div style={{ padding:14, paddingBottom:90 }}>
          <div style={{ display:"flex", background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:3, marginBottom:12 }}>
            {[["period","期間"],["tournament","大会"],["individual","個別"],["all","すべて"]].map(([v,l])=>(
              <div key={v} onClick={()=>setSelectSubTab(v)} style={{ flex:1, textAlign:"center", fontSize:11.5, fontWeight:700, padding:"8px 2px", borderRadius:8, cursor:"pointer", background:selectSubTab===v?C.navy:"transparent", color:selectSubTab===v?"#fff":C.textSec }}>{l}</div>
            ))}
          </div>

          {selectSubTab === "period" && (() => {
            const daysInMonth = new Date(calViewYear, calViewMonth+1, 0).getDate();
            const firstDow = new Date(calViewYear, calViewMonth, 1).getDay();
            const todayIso = today();
            const padMonth = (m) => String(m+1).padStart(2,"0");
            const toIso = (d) => `${calViewYear}-${padMonth(calViewMonth)}-${String(d).padStart(2,"0")}`;
            const handleDayClick = (d) => {
              const iso = toIso(d);
              if (calFilterMode === "day") {
                setCalDay(iso); setPeriodStart(iso); setPeriodEnd(iso);
              } else if (calFilterMode === "range") {
                if (calRangeStep === "start") {
                  setCalRangeStart(iso); setCalRangeEnd(null); setCalRangeStep("end");
                } else {
                  if (iso < calRangeStart) { setCalRangeStart(iso); setCalRangeStep("end"); }
                  else { setCalRangeEnd(iso); setCalRangeStep("start"); setPeriodStart(calRangeStart); setPeriodEnd(iso); }
                }
              }
            };
            const getDayClass = (iso) => {
              if (calFilterMode === "day") return iso === calDay ? "sel" : "";
              if (calFilterMode === "range") {
                if (iso === calRangeStart) return "rs";
                if (iso === calRangeEnd) return "re";
                if (calRangeStart && calRangeEnd && iso > calRangeStart && iso < calRangeEnd) return "ir";
              }
              return "";
            };
            const DOW = ["日","月","火","水","木","金","土"];
            return (
              <div style={{ background:C.white, borderRadius:14, border:`1.5px solid ${C.border}`, overflow:"hidden", marginBottom:12 }}>
                <div style={{ display:"flex", borderBottom:`1.5px solid ${C.border}` }}>
                  {[["day","1日指定"],["range","期間指定"],["month","月指定"]].map(([v,l])=>(
                    <button key={v} onClick={()=>{ setCalFilterMode(v); if(v==="range"){setCalRangeStart(null);setCalRangeEnd(null);setCalRangeStep("start");} }} style={{ flex:1, padding:"10px 4px", textAlign:"center", fontSize:13, fontWeight:700, color:calFilterMode===v?C.accent:C.textSec, border:"none", background:"none", cursor:"pointer", borderBottom:calFilterMode===v?`2px solid ${C.accent}`:"2px solid transparent" }}>{l}</button>
                  ))}
                </div>
                <div style={{ padding:"12px 14px 0" }}>
                  {(calFilterMode==="day"||calFilterMode==="range") && (<>
                    {calFilterMode==="range" && (
                      <p style={{ fontSize:11, color:C.textSec, textAlign:"center", marginBottom:8 }}>
                        {calRangeStep==="start" ? <>開始日 → 終了日の順にタップ（<b style={{color:C.accent}}>開始日</b>を選択中）</> : <>開始日 → 終了日の順にタップ（<b style={{color:C.accent}}>終了日</b>を選択中）</>}
                      </p>
                    )}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                      <button onClick={()=>{ if(calViewMonth===0){setCalViewMonth(11);setCalViewYear(y=>y-1);}else setCalViewMonth(m=>m-1); }} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:C.navy, padding:"4px 8px" }}>‹</button>
                      <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{calViewYear}年{calViewMonth+1}月</span>
                      <button onClick={()=>{ if(calViewMonth===11){setCalViewMonth(0);setCalViewYear(y=>y+1);}else setCalViewMonth(m=>m+1); }} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:C.navy, padding:"4px 8px" }}>›</button>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:10 }}>
                      {DOW.map((d,i)=>(
                        <div key={d} style={{ textAlign:"center", fontSize:11, fontWeight:700, color:i===0?"#e53935":i===6?"#1565c0":C.textSec, padding:"3px 0" }}>{d}</div>
                      ))}
                      {Array.from({length:firstDow}).map((_,i)=><div key={"e"+i}/>)}
                      {Array.from({length:daysInMonth}).map((_,i)=>{
                        const d=i+1; const iso=toIso(d); const dc=getDayClass(iso);
                        const dow=(firstDow+i)%7;
                        const isToday=iso===todayIso;
                        const isSel=dc==="sel"||dc==="rs"||dc==="re";
                        const isInRange=dc==="ir";
                        return (
                          <button key={d} onClick={()=>handleDayClick(d)} style={{
                            textAlign:"center", fontSize:13, padding:"7px 2px", borderRadius: dc==="rs"?"8px 0 0 8px":dc==="re"?"0 8px 8px 0":"8px",
                            cursor:"pointer", fontWeight:600, border:"none",
                            background:isSel?C.accent:isInRange?C.accentL:"transparent",
                            color:isSel?"#fff":isInRange?"#00874f":dow===0?"#e53935":dow===6?"#1565c0":isToday?C.accent:C.text,
                            outline:isToday&&!isSel?`1.5px solid ${C.accent}`:"none",
                          }}>{d}</button>
                        );
                      })}
                    </div>
                  </>)}
                  {calFilterMode==="month" && (<>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16, marginBottom:10 }}>
                      <button onClick={()=>setCalMonthViewYear(y=>y-1)} style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:C.navy }}>‹</button>
                      <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{calMonthViewYear}年</span>
                      <button onClick={()=>setCalMonthViewYear(y=>y+1)} style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:C.navy }}>›</button>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:10 }}>
                      {Array.from({length:12}).map((_,i)=>{
                        const mStr = `${calMonthViewYear}-${String(i+1).padStart(2,"0")}`;
                        const isSel = calMonth===mStr;
                        const hasData = playerMatches.some(m=>(m.match_date||"").slice(0,7)===mStr);
                        return (
                          <button key={i} onClick={()=>{
                            setCalMonth(mStr);
                            const lastDay = new Date(calMonthViewYear, i+1, 0).getDate();
                            setPeriodStart(`${mStr}-01`); setPeriodEnd(`${mStr}-${String(lastDay).padStart(2,"0")}`);
                          }} style={{ padding:"10px 4px", textAlign:"center", borderRadius:8, cursor:"pointer", fontSize:14, fontWeight:700, border: isSel?`1.5px solid ${C.accent}`:hasData?`1.5px solid ${C.accent}`:`1.5px solid ${C.border}`, background:isSel?C.accent:"#fff", color:isSel?"#fff":hasData?"#00874f":C.text }}>{i+1}月</button>
                        );
                      })}
                    </div>
                    <p style={{ fontSize:11, color:C.textSec, textAlign:"center", marginBottom:10 }}>枠線あり＝試合データあり</p>
                  </>)}
                </div>
                {(periodStart || periodEnd) && (
                  <div style={{ padding:"0 14px 14px" }}>
                    <button onClick={()=>{ setPeriodStart(""); setPeriodEnd(""); setCalDay(null); setCalRangeStart(null); setCalRangeEnd(null); setCalMonth(null); }} style={{ width:"100%", padding:"9px", background:C.gray, color:C.textSec, border:"none", borderRadius:10, fontSize:12.5, fontWeight:700, cursor:"pointer" }}>選択をクリア（{periodStart||"…"} 〜 {periodEnd||"…"}）</button>
                  </div>
                )}
              </div>
            );
          })()}

          {selectSubTab === "tournament" && (
            <div style={S.card}>
              <div style={{ padding:"6px 4px" }}>
                {tournamentNames.length===0 && <div style={{ padding:16, textAlign:"center", color:C.textSec, fontSize:12 }}>対象の大会がありません</div>}
                {tournamentNames.map(name => (
                  <div key={name} onClick={()=>setSelectedTournaments(prev => prev.includes(name) ? prev.filter(n=>n!==name) : [...prev, name])}
                    style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderBottom:`1px solid ${C.border}`, cursor:"pointer" }}>
                    <div style={{ width:18,height:18,borderRadius:5,border:`2px solid ${selectedTournaments.includes(name)?C.accent:C.border}`, background:selectedTournaments.includes(name)?C.accent:"transparent", color:"#fff", fontSize:11, display:"flex",alignItems:"center",justifyContent:"center" }}>{selectedTournaments.includes(name)?"✓":""}</div>
                    <div style={{ fontSize:12.5, fontWeight:600 }}>{name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectSubTab === "individual" && (
            <div style={S.card}>
              <div style={{ padding:"6px 4px", maxHeight:360, overflowY:"auto" }}>
                {sortedForList.length===0 && <div style={{ padding:16, textAlign:"center", color:C.textSec, fontSize:12 }}>対象の試合がありません</div>}
                {sortedForList.map(m => {
                  const win = winForPlayer(m, selectedPlayer, effectiveSchoolName);
                  const oppSide = m.players.find(p=>p.player_name!==selectedPlayer && p.team!==(ownSideFor(m,selectedPlayer,effectiveSchoolName)));
                  const on = selectedMatchIds.includes(m.id);
                  return (
                    <div key={m.id} onClick={()=>setSelectedMatchIds(prev => on ? prev.filter(id=>id!==m.id) : [...prev, m.id])}
                      style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 4px", borderBottom:`1px solid ${C.border}`, cursor:"pointer" }}>
                      <div style={{ width:18,height:18,borderRadius:5,border:`2px solid ${on?C.accent:C.border}`, background:on?C.accent:"transparent", color:"#fff", fontSize:11, display:"flex",alignItems:"center",justifyContent:"center", flexShrink:0 }}>{on?"✓":""}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:10, color:C.textSec }}>{fmtDate(m.match_date)}・{m.tournament_name}</div>
                        <div style={{ fontSize:12, fontWeight:700, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>vs {oppSide?.club_name || ""} {m.players.filter(p=>p.team!==ownSideFor(m,selectedPlayer,effectiveSchoolName)).map(p=>p.player_name).join("/")}</div>
                      </div>
                      <div style={{ fontSize:11, fontWeight:800, padding:"2px 8px", borderRadius:6, color:win?C.accent:C.red, background:win?C.accentL:C.redL, flexShrink:0 }}>{win?"勝ち":"負け"}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectSubTab === "all" && (
            <div style={{ ...S.card, padding:"12px 14px" }}>
              <div style={{ fontSize:12, color:C.textSec }}>選手が出場したすべての試合が対象になります</div>
            </div>
          )}

          <div style={{ ...S.card, padding:"12px 14px" }}>
            <div style={{ fontSize:12, color:C.textSec }}>この条件に一致する試合</div>
            <div style={{ fontSize:20, fontWeight:800, color:C.navy, marginTop:2 }}>{candidateMatches.length}試合</div>
          </div>

          <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} disabled={candidateMatches.length===0 || resultLoading}
            onClick={()=>loadResults(candidateMatches, condLabelFor())}>
            {resultLoading ? "読み込み中..." : `この${candidateMatches.length}試合を分析する →`}
          </button>
        </div>
      </div>
    );
  }

  // ============ ③ 分析結果（デフォルト表示もここ） ============
  const agg = aggregatePlayerStats(resultMatches, selectedPlayer, effectiveSchoolName);
  const topPlaysWin = Object.entries(agg.playsWin).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const topPlaysErr = Object.entries(agg.playsErr).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const maxPlayCount = Math.max(1, ...topPlaysWin.map(x=>x[1]), ...topPlaysErr.map(x=>x[1]));

  const sortedResults = [...resultMatches].sort((a,b)=> new Date(a.match_date)-new Date(b.match_date));
  const oldestM = sortedResults[0], newestM = sortedResults[sortedResults.length-1];
  const canShowGrowth = sortedResults.length >= 2 && oldestM.id !== newestM.id;
  const oldestRates = canShowGrowth ? keyRatesFromAgg(aggregatePlayerStats([oldestM], selectedPlayer, effectiveSchoolName)) : null;
  const newestRates = canShowGrowth ? keyRatesFromAgg(aggregatePlayerStats([newestM], selectedPlayer, effectiveSchoolName)) : null;

  const wonMatches = resultMatches.filter(m => winForPlayer(m, selectedPlayer, effectiveSchoolName) === true);
  const lostMatches = resultMatches.filter(m => winForPlayer(m, selectedPlayer, effectiveSchoolName) === false);
  const wonRates = keyRatesFromAgg(aggregatePlayerStats(wonMatches, selectedPlayer, effectiveSchoolName));
  const lostRates = keyRatesFromAgg(aggregatePlayerStats(lostMatches, selectedPlayer, effectiveSchoolName));

  const metricLabel = { serveRate:"1stサーブ成功率", receiveMissRate:"レシーブミス率", decisionRate:"決定率" };

  return (
    <div style={{ minHeight:"100vh", background:C.gray, paddingBottom:70, fontFamily:"'Helvetica Neue','Hiragino Kaku Gothic ProN','Meiryo',sans-serif" }}>
      <div style={{ background:C.navy, color:C.white, padding:16 }}>
        <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ display:"flex", background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:3, marginBottom:12 }}>
          <div style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, background:C.navy, color:"#fff" }}>個人分析</div>
          <div onClick={onOpenTeamStats} style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, color:C.textSec, cursor:"pointer" }}>チーム統計</div>
        </div>

        <div style={{ background:C.navy, color:"#fff", borderRadius:14, padding:14, marginBottom:12 }}>
          <div style={{ fontSize:11, color:"#b9c2d6", marginBottom:4 }}>{resultCondLabel}</div>
          <div style={{ fontSize:15, fontWeight:800 }}>{selectedPlayer}さん・{resultMatches.length}試合</div>
        </div>

        <button
          style={{ width:"100%", padding:12, background:"#fff", border:`1px solid ${C.border}`, borderRadius:10, color:C.navy, fontSize:13, fontWeight:700, cursor:"pointer", marginBottom:12 }}
          onClick={()=>setMode("wizardPlayer")}
        >🔧 条件を変更する（選手・試合を選び直す）</button>

        {resultLoading ? (
          <div style={{ textAlign:"center", padding:40, color:C.textSec }}>集計中...</div>
        ) : resultMatches.length===0 ? (
          <div style={{ ...S.card, padding:24, textAlign:"center", color:C.textSec, fontSize:12.5 }}>対象の試合がありません</div>
        ) : (
          <>
            {/* 得点・ミスの内訳 */}
            <div style={S.card}>
              <div style={{ padding:14 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.navy, marginBottom:10 }}>📋 得点・ミスの内訳（合計）</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:10 }}>
                  <div style={{ textAlign:"center", padding:"10px 2px", background:C.gray, borderRadius:10 }}>
                    <div style={{ fontSize:18, fontWeight:800, color:C.navy }}>{agg.winners}</div>
                    <div style={{ fontSize:9.5, color:C.textSec, marginTop:2 }}>総得点</div>
                  </div>
                  <div style={{ textAlign:"center", padding:"10px 2px", background:C.gray, borderRadius:10 }}>
                    <div style={{ fontSize:18, fontWeight:800, color:C.navy }}>{agg.errors}</div>
                    <div style={{ fontSize:9.5, color:C.textSec, marginTop:2 }}>総ミス</div>
                  </div>
                  <div style={{ textAlign:"center", padding:"10px 2px", background:C.gray, borderRadius:10 }}>
                    <div style={{ fontSize:18, fontWeight:800, color:agg.winners-agg.errors>=0?C.accent:C.red }}>{agg.winners-agg.errors>=0?"+":""}{agg.winners-agg.errors}</div>
                    <div style={{ fontSize:9.5, color:C.textSec, marginTop:2 }}>得失点差</div>
                  </div>
                </div>
                {topPlaysWin.map(([label,count])=>(
                  <div key={"w"+label} style={{ display:"flex", alignItems:"center", fontSize:12, padding:"5px 0" }}>
                    <div style={{ width:76, color:C.text, fontWeight:700 }}>{getPlayLabel ? getPlayLabel(label) : label}</div>
                    <div style={{ flex:1, height:8, background:"#eef0f3", borderRadius:4, margin:"0 8px", overflow:"hidden" }}><div style={{ height:"100%", width:`${count/maxPlayCount*100}%`, background:C.accent, borderRadius:4 }}/></div>
                    <div style={{ width:26, textAlign:"right", fontWeight:700, color:C.navy }}>{count}</div>
                  </div>
                ))}
                {topPlaysWin.length>0 && topPlaysErr.length>0 && <div style={{ height:6 }}/>}
                {topPlaysErr.map(([label,count])=>(
                  <div key={"e"+label} style={{ display:"flex", alignItems:"center", fontSize:12, padding:"5px 0" }}>
                    <div style={{ width:76, color:C.text, fontWeight:700 }}>{getPlayLabel ? getPlayLabel(label) : label}</div>
                    <div style={{ flex:1, height:8, background:"#eef0f3", borderRadius:4, margin:"0 8px", overflow:"hidden" }}><div style={{ height:"100%", width:`${count/maxPlayCount*100}%`, background:C.red, borderRadius:4 }}/></div>
                    <div style={{ width:26, textAlign:"right", fontWeight:700, color:C.navy }}>{count}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* 変化した点 */}
            <div style={S.card}>
              <div style={{ padding:14 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.navy, marginBottom:10 }}>📈 変化した点（一番古い試合 → 一番新しい試合）</div>
                {!canShowGrowth ? (
                  <div style={{ fontSize:12, color:C.textSec }}>比較するには試合が2件以上必要です</div>
                ) : (
                  Object.keys(metricLabel).map(key => {
                    const ov = oldestRates[key], nv = newestRates[key];
                    if (ov==null || nv==null) return null;
                    const delta = nv - ov;
                    const isMiss = key==="receiveMissRate";
                    const good = isMiss ? delta<=0 : delta>=0;
                    return (
                      <div key={key} style={{ display:"flex", alignItems:"center", padding:"9px 0", borderBottom:`1px solid ${C.border}` }}>
                        <div style={{ flex:1, fontSize:12.5, fontWeight:700, color:C.text }}>{metricLabel[key]}</div>
                        <div style={{ fontSize:11.5, color:C.textSec, marginRight:8 }}>{ov}% → {nv}%</div>
                        <div style={{ fontSize:11, fontWeight:800, padding:"2px 8px", borderRadius:6, color:good?C.accent:C.red, background:good?C.accentL:C.redL }}>{delta>=0?"+":""}{delta}pt</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* 勝敗別データ比較 */}
            <div style={S.card}>
              <div style={{ padding:14 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.navy, marginBottom:10 }}>⚖️ 勝った試合 と 負けた試合の比較</div>
                {wonMatches.length===0 || lostMatches.length===0 ? (
                  <div style={{ fontSize:12, color:C.textSec }}>比較するには、勝った試合・負けた試合の両方が必要です</div>
                ) : (
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead>
                      <tr>
                        <th></th>
                        <th style={{ fontSize:10.5,color:C.accent,fontWeight:700,padding:"6px 4px" }}>勝ち（{wonMatches.length}試合）</th>
                        <th style={{ fontSize:10.5,color:C.red,fontWeight:700,padding:"6px 4px" }}>負け（{lostMatches.length}試合）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.keys(metricLabel).map(key => (
                        <tr key={key}>
                          <td style={{ padding:"8px 4px", color:C.textSec, fontWeight:600, borderTop:`1px solid ${C.border}` }}>{metricLabel[key]}</td>
                          <td style={{ padding:"8px 4px", textAlign:"center", fontWeight:700, color:C.accent, borderTop:`1px solid ${C.border}` }}>{wonRates[key]==null?"—":wonRates[key]+"%"}</td>
                          <td style={{ padding:"8px 4px", textAlign:"center", fontWeight:700, color:C.red, borderTop:`1px solid ${C.border}` }}>{lostRates[key]==null?"—":lostRates[key]+"%"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}

      </div>
      <NavBar active="stats" onNavigate={onNavigate}/>
    </div>
  );
}


function StatsScreen({ onNavigate, onOpenPlayer, onOpenOpponent, onOpenMatch }) {
  const initialPrefs = useState(() => loadStatsFilterPrefs())[0];

  const [allMatches, setAllMatches] = useState([]);
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [teamMatchIds, setTeamMatchIds] = useState(new Set()); // 団体戦の一戦として作成されたmatch.idの集合

  // ①試合対象カテゴリ（新規）：all(すべて) | tournament(大会) | team(団体戦) | individual(個人戦)
  const [statsCat, setStatsCat] = useState(initialPrefs.statsCat ?? "all");
  const [statsCatSub, setStatsCatSub] = useState(initialPrefs.statsCatSub ?? "allsub"); // allsub | specific
  const [statsCatTournament, setStatsCatTournament] = useState(initialPrefs.statsCatTournament ?? "");
  const [period, setPeriod] = useState(initialPrefs.period ?? "all"); // all | month1 | month3
  const [filterOpen, setFilterOpen] = useState(false);

  // ②見る内容タブ：players(選手別) | pairs(ペア別) | opponents(対戦別)
  const [tab, setTab] = useState(initialPrefs.tab ?? "players");
  const [pairMode, setPairMode] = useState(initialPrefs.pairMode ?? "own"); // own | opp
  const [oppMode, setOppMode] = useState(initialPrefs.oppMode ?? "team"); // team | pair
  const [sort, setSort] = useState("desc"); // desc | asc

  const [showBreakdown, setShowBreakdown] = useState(false); // 総合成績カードの内訳一覧
  const [deletedTournamentNames, setDeletedTournamentNames] = useState([]); // ゴミ箱に入っている大会名（絞り込み選択肢から除外用）
  const [mySchoolName, setMySchoolName] = useState(""); // ★自チーム同士の練習試合判定用

  useEffect(() => {
    Promise.all([getMatches(), getSimpleRecordedDrawMatches()]).then(([list, simpleList])=>{
      setAllMatches([...list, ...simpleList]);
      setLoading(false);
    });
  }, []);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);
  useEffect(() => {
    (async () => {
      const p = await getMyProfile();
      if (p?.school_id) {
        const schools = await getSchools();
        const s = schools.find(s => s.id === p.school_id);
        if (s) setMySchoolName(s.name);
      }
    })();
  }, []);
  // ★ゴミ箱に入っている大会名を取得。試合データ自体は削除しないが、
  //   絞り込みプルダウンには削除済みの大会名を出さないようにするため。
  useEffect(() => { getDeletedTournaments().then(list => setDeletedTournamentNames(list.map(t => t.name))); }, []);
  // ★団体戦の一戦として作成された試合（match）のIDを集めておく（個人戦との区別に使う）
  useEffect(() => {
    getTeamMatches().then(list => {
      const ids = new Set();
      list.forEach(tm => (tm.games||[]).forEach(g => { if (g.match_id) ids.add(g.match_id); }));
      setTeamMatchIds(ids);
    });
  }, []);

  // ①の絞り込み条件が変わるたびに端末に保存（次回開いたときも保持される）
  useEffect(() => {
    saveStatsFilterPrefs({ statsCat, statsCatSub, statsCatTournament, period, tab, pairMode, oppMode });
  }, [statsCat, statsCatSub, statsCatTournament, period, tab, pairMode, oppMode]);

  function resetStatsFilter() {
    setStatsCat("all"); setStatsCatSub("allsub"); setStatsCatTournament(""); setPeriod("all");
  }

  // 大会名の選択肢（登録されている試合から重複なく抽出。日付が新しい大会を上にする。削除済みの大会名は除外）
  const tournamentOptions = Array.from(
    new Map(
      allMatches
        .filter(m => m.tournament_name && !deletedTournamentNames.includes(m.tournament_name))
        .sort((a,b) => new Date(b.match_date) - new Date(a.match_date))
        .map(m => [m.tournament_name, m.tournament_name])
    ).values()
  );

  // ①カテゴリによる絞り込み
  let categoryMatches;
  if (statsCat === "tournament") categoryMatches = allMatches.filter(m => m.tournament_name && !deletedTournamentNames.includes(m.tournament_name));
  else if (statsCat === "team") categoryMatches = allMatches.filter(m => teamMatchIds.has(m.id));
  else if (statsCat === "individual") categoryMatches = allMatches.filter(m => !teamMatchIds.has(m.id));
  else categoryMatches = allMatches; // all

  if (statsCat !== "all" && statsCatSub === "specific" && statsCatTournament) {
    categoryMatches = categoryMatches.filter(m => m.tournament_name === statsCatTournament);
  }

  const periodMatches = period==="month1" ? withinLastDays(categoryMatches, 30)
    : period==="month3" ? withinLastDays(categoryMatches, 90)
    : categoryMatches;
  const finished = periodMatches.filter(m=>m.status==="finished");
  const teamRecord = recordOf(finished, m=>m.match_score_a>m.match_score_b);

  // ペア別成績（自チームAのペア名を「選手1／選手2」形式で集計）
  // ★相手チームが同じ学校（練習試合）の場合は、B側のペアも自チームのペアとして含める
  const byPair = {};
  finished.forEach(m => {
    const aPlayers = m.players.filter(p => p.team === "A").sort((a,b) => a.order_num - b.order_num);
    const pairKey = aPlayers.map(p => p.player_name).filter(Boolean).join("／") || "（不明）";
    (byPair[pairKey] ??= []).push({ match: m, win: m.match_score_a > m.match_score_b });
    const bPlayers = m.players.filter(p => p.team === "B").sort((a,b) => a.order_num - b.order_num);
    const bClub = bPlayers[0]?.club_name;
    if (mySchoolName && bClub && bClub.trim()===mySchoolName.trim()) {
      const bPairKey = bPlayers.map(p => p.player_name).filter(Boolean).join("／") || "（不明）";
      (byPair[bPairKey] ??= []).push({ match: m, win: m.match_score_b > m.match_score_a });
    }
  });
  const pairRows = Object.entries(byPair).map(([name, list]) => ({
    name, ...recordOf(list, x => x.win),
  }));
  pairRows.sort((a,b) => sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 相手チームのペア別成績（対戦相手Bのペア名で集計。勝敗は相手側から見た勝敗）
  const byOppPair = {};
  finished.forEach(m => {
    const bPlayers = m.players.filter(p => p.team === "B").sort((a,b) => a.order_num - b.order_num);
    const pairKey = bPlayers.map(p => p.player_name).filter(Boolean).join("／") || "（不明）";
    const club = bPlayers[0]?.club_name || "";
    const key = club ? `${pairKey}（${club}）` : pairKey;
    (byOppPair[key] ??= []).push(m);
  });
  const oppPairRows = Object.entries(byOppPair).map(([name, list]) => ({
    name, ...recordOf(list, m => m.match_score_b > m.match_score_a),
  }));
  oppPairRows.sort((a,b) => sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 選手別成績（選手マスターの自チーム選手のみ）
  // ★重要：同姓の相手チーム選手がいる場合の取り違えを防ぐため、
  // 　自チーム(team==="A")として出場した試合だけを対象にする。
  // 　ただし相手チームが同じ学校（東福岡 対 東福岡の練習試合など）の場合は、
  // 　B側で出場した試合も自チームの成績として含める。
  const playerRows = roster.filter(p=>p.is_own_team!==false).map(p=>{
    const myMatches = finished.filter(m=>ownSideFor(m,p.player_name,mySchoolName));
    const rec = recordOf(myMatches, m=>winForPlayer(m,p.player_name,mySchoolName));
    return { name: p.player_name, ...rec };
  }).filter(r=>r.total>0);
  playerRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 対戦相手（学校）別成績
  const byOpponent = {};
  finished.forEach(m=>{
    const name = m.players.find(p=>p.team==="B")?.club_name || "（相手不明）";
    (byOpponent[name] ??= []).push(m);
  });
  const opponentRows = Object.entries(byOpponent).map(([name,list])=>({
    name, ...recordOf(list, m=>m.match_score_a>m.match_score_b),
  }));
  opponentRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  const subLabel = statsCat!=="all" ? (statsCatSub==="specific" && statsCatTournament ? `（${statsCatTournament}）` : "（すべて）") : "";
  const filterSummary = `${STATS_CAT_LABELS[statsCat]}${subLabel}・${STATS_PERIOD_LABELS[period]}`;

  return (
    <div style={S.page}>
      <div style={{ background:C.navy, color:C.white, padding:16 }}>
        <div style={{ fontSize:20, fontWeight:800 }}>分析</div>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        <div style={{ display:"flex", background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:3, marginBottom:12 }}>
          <div onClick={()=>onNavigate&&onNavigate("stats")} style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, color:C.textSec, cursor:"pointer" }}>個人分析</div>
          <div style={{ flex:1, textAlign:"center", padding:"9px 4px", fontSize:12.5, fontWeight:700, borderRadius:8, background:C.navy, color:"#fff" }}>チーム統計</div>
        </div>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : allMatches.filter(m=>m.status==="finished").length===0 ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>集計できる試合がまだありません</div>
        ) : (
          <>
            {/* 折りたたみ式：①試合対象・期間フィルター */}
            <div style={{ background:C.white, border:"1px solid "+C.border, borderRadius:10, marginBottom:14, overflow:"hidden" }}>
              <div
                style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 12px", cursor:"pointer" }}
                onClick={()=>setFilterOpen(v=>!v)}
              >
                <span style={{ fontSize:12.5, fontWeight:700, color:C.text }}>{filterSummary}</span>
                <span style={{ fontSize:11, color:C.textSec }}>{filterOpen ? "非表示 ▲" : "表示 ▼"}</span>
              </div>
              {filterOpen && (
                <div style={{ padding:"0 12px 12px", borderTop:"1px solid "+C.border, paddingTop:12 }}>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>① 試合対象</div>
                  <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                    {[["all","すべて"],["tournament","大会"],["team","団体戦"],["individual","個人戦"]].map(([v,l])=>(
                      <button
                        key={v}
                        style={{ ...S.togBtn(statsCat===v, C.purple), flex:1, fontSize:12, padding:"9px 2px" }}
                        onClick={()=>{ setStatsCat(v); setStatsCatSub("allsub"); }}
                      >{l}</button>
                    ))}
                  </div>
                  {statsCat!=="all" && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                        {[["allsub","すべて"],["specific","大会を指定"]].map(([v,l])=>(
                          <button
                            key={v}
                            style={{ ...S.togBtn(statsCatSub===v, C.purple), flex:1, fontSize:12, padding:"8px 4px" }}
                            onClick={()=>setStatsCatSub(v)}
                          >{l}</button>
                        ))}
                      </div>
                      {statsCatSub==="specific" && (
                        <select
                          value={statsCatTournament}
                          onChange={e=>setStatsCatTournament(e.target.value)}
                          style={{ width:"100%", padding:"9px 10px", borderRadius:8, border:"1px solid "+C.border, fontSize:12.5, color:C.text, background:C.white }}
                        >
                          <option value="">大会を選択してください</option>
                          {tournamentOptions.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                  <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                    {[["all","全期間"],["month1","直近1ヶ月"],["month3","直近3ヶ月"]].map(([v,l])=>(
                      <button key={v} style={{ ...S.togBtn(period===v, C.navy), flex:1, fontSize:11.5, padding:"8px 2px" }} onClick={()=>setPeriod(v)}>{l}</button>
                    ))}
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <span style={{ fontSize:11, color:C.textSec, textDecoration:"underline", cursor:"pointer" }} onClick={resetStatsFilter}>リセット</span>
                  </div>
                </div>
              )}
            </div>

            {/* ②見る内容タブ：選手別／ペア別／対戦別 */}
            <div style={{ display:"flex",gap:6,marginBottom:10 }}>
              {[["players","選手別"],["pairs","ペア別"],["opponents","対戦別"]].map(([v,l])=>(
                <button key={v} style={{ ...S.togBtn(tab===v,C.navy),flex:1,fontSize:12,padding:"8px 4px" }} onClick={()=>setTab(v)}>{l}</button>
              ))}
            </div>
            {tab==="pairs" && (
              <div style={{ display:"flex", gap:6, marginBottom:10 }}>
                {[["own","自チームのペア"],["opp","相手チームのペア"]].map(([v,l])=>(
                  <button key={v} style={{ ...S.togBtn(pairMode===v, C.accent), flex:1, fontSize:11.5, padding:"7px 4px" }} onClick={()=>setPairMode(v)}>{l}</button>
                ))}
              </div>
            )}
            {tab==="opponents" && (
              <div style={{ display:"flex", gap:6, marginBottom:10 }}>
                {[["team","対戦相手チーム別"],["pair","ペア別"]].map(([v,l])=>(
                  <button key={v} style={{ ...S.togBtn(oppMode===v, C.accent), flex:1, fontSize:11.5, padding:"7px 4px" }} onClick={()=>setOppMode(v)}>{l}</button>
                ))}
              </div>
            )}

            <div style={{ display:"flex",gap:6,marginBottom:12 }}>
              <button style={{ ...S.togBtn(sort==="desc",C.accent),flex:1,fontSize:11.5,padding:"7px 4px" }} onClick={()=>setSort("desc")}>勝率が高い順</button>
              <button style={{ ...S.togBtn(sort==="asc",C.accent),flex:1,fontSize:11.5,padding:"7px 4px" }} onClick={()=>setSort("asc")}>勝率が低い順</button>
            </div>

            <div style={{ ...S.card, padding:16, marginBottom:16, cursor:"pointer" }} onClick={()=>setShowBreakdown(true)}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ fontSize:12,fontWeight:700,color:C.navy }}>総合成績</div>
                <div style={{ fontSize:10,color:C.textSec }}>タップして試合一覧を見る ›</div>
              </div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                <div>
                  <div style={{ fontSize:20,fontWeight:800 }}>{teamRecord.total}</div>
                  <div style={{ fontSize:11,color:C.textSec }}>試合数</div>
                </div>
                <div>
                  <div style={{ fontSize:20,fontWeight:800,color:C.accent }}>{teamRecord.rate}%</div>
                  <div style={{ fontSize:11,color:C.textSec }}>勝率</div>
                </div>
                <div>
                  <div style={{ fontSize:20,fontWeight:800 }}>{teamRecord.wins}勝{teamRecord.losses}敗</div>
                  <div style={{ fontSize:11,color:C.textSec }}>戦績</div>
                </div>
              </div>
            </div>
            <MonthlyTrendCard finishedMatches={finished} winFn={m=>m.match_score_a>m.match_score_b} />

            {tab==="players" && (
              <>
                <div style={{ fontSize:11,color:C.textSec,marginBottom:8 }}>タップすると、その選手のペア別成績を見られます</div>
                {playerRows.length===0 ? (
                  <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この条件の試合記録がありません</div>
                ) : playerRows.map(r=>(
                  <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }} onClick={()=>onOpenPlayer(r.name)}>
                    <span style={{ fontSize:14,fontWeight:700 }}>{r.name}</span>
                    <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
                  </div>
                ))}
              </>
            )}
            {tab==="pairs" && (
              <>
                {(pairMode==="own" ? pairRows : oppPairRows).length===0 ? (
                  <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この条件の試合記録がありません</div>
                ) : (pairMode==="own" ? pairRows : oppPairRows).map(r=>(
                  <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8 }}>
                    <div style={{ fontSize:13,fontWeight:700,color:C.text,marginBottom:4 }}>{r.name}</div>
                    <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.total}試合</span>
                      <span style={{ fontSize:14,fontWeight:700,color:C.accent }}>{r.rate}%</span>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗</span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {tab==="opponents" && (
              <>
                {oppMode==="team" && <div style={{ fontSize:11,color:C.textSec,marginBottom:8 }}>タップすると、相手選手・ペア別の成績を見られます</div>}
                {(oppMode==="team" ? opponentRows : oppPairRows).length===0 ? (
                  <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この条件の試合記録がありません</div>
                ) : oppMode==="team" ? opponentRows.map(r=>(
                  <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }} onClick={()=>onOpenOpponent(r.name)}>
                    <span style={{ fontSize:14,fontWeight:700 }}>{r.name}</span>
                    <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
                  </div>
                )) : oppPairRows.map(r=>(
                  <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8 }}>
                    <div style={{ fontSize:13,fontWeight:700,color:C.text,marginBottom:4 }}>{r.name}</div>
                    <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.total}試合</span>
                      <span style={{ fontSize:14,fontWeight:700,color:C.accent }}>{r.rate}%</span>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <NavBar active="stats" onNavigate={onNavigate}/>

      {showBreakdown && (
        <Modal onClose={()=>setShowBreakdown(false)}>
          <div style={{ maxHeight:"75vh", overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:2 }}>
              <div style={{ fontSize:15, fontWeight:800 }}>総合成績の内訳</div>
              <button
                style={{ border:"none", background:"none", fontSize:20, color:C.textSec, cursor:"pointer", lineHeight:1, padding:0, marginLeft:8, marginRight:10, flex:"none" }}
                onClick={()=>setShowBreakdown(false)}
                aria-label="閉じる"
              >×</button>
            </div>
            <div style={{ fontSize:11.5, color:C.textSec, marginBottom:14 }}>
              {teamRecord.total}試合（{teamRecord.wins}勝{teamRecord.losses}敗）・タップすると試合詳細を開きます
            </div>
            {finished.slice().sort((a,b)=> sort==="desc" ? new Date(b.match_date)-new Date(a.match_date) : new Date(a.match_date)-new Date(b.match_date)).map(m=>{
              const aWin = m.match_score_a > m.match_score_b;
              const aPlayers = m.players.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num);
              const bPlayers = m.players.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num);
              const aNames = aPlayers.map(p=>p.player_name).join("/");
              const bNames = bPlayers.map(p=>p.player_name).join("/");
              const bClub = bPlayers[0]?.club_name || "";
              return (
                <div
                  key={m.id}
                  style={{ border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", marginBottom:8, cursor:"pointer" }}
                  onClick={()=>{ setShowBreakdown(false); onOpenMatch && onOpenMatch(m.id); }}
                >
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontSize:10.5, color:C.textSec }}>{fmtDate(m.match_date)}{m.tournament_name ? ` · ${m.tournament_name}` : ""}</span>
                    <span style={{ fontSize:16, fontWeight:900, color:aWin?C.teamA:C.teamB }}>{m.match_score_a}-{m.match_score_b}</span>
                  </div>
                  <div style={{ fontSize:12.5, fontWeight: aWin?700:400, color: aWin?C.teamA:C.text }}>{aNames}</div>
                  <div style={{ fontSize:11, color:C.textSec, marginTop:2 }}>vs {bClub && `${bClub} `}{bNames}</div>
                </div>
              );
            })}
            {finished.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>この条件の試合記録がありません</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}


// ============================================================
// 特定選手の戦績画面（保護者の「お子さんの戦績」/選手本人の「自分の戦績」）
// ============================================================
function PlayerStatsScreen({ onBack, onOpen, initialPlayerName }) {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState([]);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [playerName, setPlayerName] = useState(initialPlayerName || null); // 現在表示中の選手（未選択ならnull＝選択画面）
  const [matches, setMatches] = useState([]);
  const [period, setPeriod] = useState("all");
  const [sort, setSort] = useState("desc");
  const [mySchoolName, setMySchoolName] = useState(""); // ★自チーム同士の練習試合判定用

  useEffect(() => {
    (async () => {
      const profile = await getMyProfile();
      const rosterList = await getPlayerRoster();
      setRoster(rosterList);
      if (profile?.linked_player_id) {
        const found = rosterList.find(p => p.id === profile.linked_player_id);
        setLinkedPlayerName(found?.player_name ?? null);
      }
      if (profile?.school_id) {
        const schools = await getSchools();
        const s = schools.find(s => s.id === profile.school_id);
        if (s) setMySchoolName(s.name);
      }
      const list = await getMatches();
      setMatches(list);
      setLoading(false);
    })();
  }, []);

  const periodMatches = period==="month1" ? withinLastDays(matches, 30) : matches;
  const ownRoster = roster.filter(p=>p.is_own_team!==false);
  const myMatches = playerName ? periodMatches.filter(m => ownSideFor(m, playerName, mySchoolName)) : [];
  const finished = myMatches.filter(m => m.status === "finished");
  const rec = recordOf(finished, m=>winForPlayer(m, playerName, mySchoolName));

  // ペア（相方）別成績
  const byPartner = {};
  finished.forEach(m=>{
    const partner = partnerOf(m, playerName, mySchoolName) || "（相方不明）";
    (byPartner[partner] ??= []).push(m);
  });
  const partnerRows = Object.entries(byPartner).map(([name,list])=>({
    name, ...recordOf(list, m=>winForPlayer(m,playerName,mySchoolName)),
  }));
  partnerRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 全試合（未確定含む）は日付の新しい順表示用に元のmyMatchesを使う（期間でフィルタ済み）
  const allFinishedForTrend = playerName ? matches.filter(m=>m.status==="finished" && ownSideFor(m, playerName, mySchoolName)) : [];

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={()=>{ if (playerName && !initialPlayerName) setPlayerName(null); else onBack(); }}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{playerName ? `${playerName}さんの戦績` : "選手を選ぶ"}</span>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:40 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : !playerName ? (
          // ★選手選択画面
          ownRoster.length===0 ? (
            <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>選手マスター(自チーム)に選手が登録されていません。</div>
          ) : (
            <>
              <div style={{ fontSize:12,color:C.textSec,marginBottom:10 }}>戦績を見たい選手を選んでください</div>
              {ownRoster.map(p=>(
                <div
                  key={p.id}
                  style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
                  onClick={()=>setPlayerName(p.player_name)}
                >
                  <span style={{ fontSize:14,fontWeight:700 }}>{p.player_name}{p.player_name===linkedPlayerName ? "（自分／お子さん）" : ""}</span>
                  <span style={{ fontSize:14,color:C.textSec }}>→</span>
                </div>
              ))}
            </>
          )
        ) : (
          <>
            <PeriodSortBar period={period} setPeriod={setPeriod} sort={sort} setSort={setSort} />

            {finished.length===0 ? (
              <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この期間の試合記録がありません</div>
            ) : (
              <>
                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                    <div>
                      <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{rec.total}</div>
                      <div style={{ fontSize:11,color:C.textSec }}>試合数</div>
                    </div>
                    <div>
                      <div style={{ fontSize:22,fontWeight:800,color:C.accent }}>{rec.rate}%</div>
                      <div style={{ fontSize:11,color:C.textSec }}>勝率</div>
                    </div>
                    <div>
                      <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{rec.wins}勝{rec.losses}敗</div>
                      <div style={{ fontSize:11,color:C.textSec }}>戦績</div>
                    </div>
                  </div>
                </div>

                {/* ペア別成績 */}
                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>ペア別の成績</div>
                  {partnerRows.map(r=>(
                    <div key={r.name} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}` }}>
                      <span style={{ fontSize:13 }}>{r.name}</span>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
                    </div>
                  ))}
                </div>

                <MonthlyTrendCard finishedMatches={allFinishedForTrend} winFn={m=>winForPlayer(m,playerName)} />

                <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:8 }}>試合一覧</div>
                {myMatches.map(m=>{
                  const win = m.status==="finished" ? winForPlayer(m,playerName) : null;
                  const aP = m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
                  const bC = m.players.find(p=>p.team==="B")?.club_name??"";
                  const bP = m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
                  return (
                    <div key={m.id} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                      <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                        <span style={{ fontSize:12,fontWeight:700 }}>{m.tournament_name||"試合"}</span>
                        <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(m.match_date)}</span>
                      </div>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:m.memo?6:0 }}>
                        <span style={{ fontSize:12,color:C.textSec }}>{aP} vs {bC} {bP}</span>
                        <span style={{ fontSize:14,fontWeight:800,color:m.status==="finished"?(win?C.teamA:C.teamB):C.textSec }}>
                          {matchStatusShortLabel(m)}
                        </span>
                      </div>
                      {m.status==="finished" && (
                        <button
                          style={{ marginTop:6, fontSize:11, color:C.textSec, background:C.gray, border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 10px", cursor:"pointer" }}
                          onClick={async (e)=>{
                            e.stopPropagation();
                            if (!window.confirm("この試合を「途中終了」扱いに変更しますか？\nスコアはそのまま残りますが、勝敗の集計から除外されます。")) return;
                            try {
                              await supabase.from("matches").update({ status:"abandoned" }).eq("id", m.id);
                              setMatches(prev => prev.map(x => x.id===m.id ? { ...x, status:"abandoned" } : x));
                            } catch(err) { alert("エラー: " + (err.message||err)); }
                          }}
                        >この試合を途中終了扱いにする（勝敗集計から除外）</button>
                      )}
                      {m.memo && (
                        <div style={{ fontSize:11,color:C.navy,background:C.accentL,borderRadius:6,padding:"6px 8px",marginTop:4 }}>📝 {m.memo}</div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 対戦相手（学校）別の戦績画面
// ============================================================
function OpponentStatsScreen({ schoolName, onBack, onOpen }) {
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState([]);
  const [period, setPeriod] = useState("all");
  const [sort, setSort] = useState("desc");

  useEffect(() => { getMatches().then(list=>{ setMatches(list); setLoading(false); }); }, []);

  const oppOf = m => m.players.find(p=>p.team==="B")?.club_name || "";
  const periodMatches = period==="month1" ? withinLastDays(matches, 30) : matches;
  const vsMatches = periodMatches.filter(m => oppOf(m)===schoolName);
  const finished = vsMatches.filter(m => m.status==="finished");
  const rec = recordOf(finished, m=>m.match_score_a>m.match_score_b);

  // 相手選手別・相手ペア別（こちらの勝率で集計）
  const byOppPlayer = {};
  const byOppPair = {};
  finished.forEach(m=>{
    const bNames = m.players.filter(p=>p.team==="B").map(p=>p.player_name);
    bNames.forEach(name => { (byOppPlayer[name] ??= []).push(m); });
    const pairKey = bNames.slice().sort().join(" / ");
    if (pairKey) (byOppPair[pairKey] ??= []).push(m);
  });
  const oppPlayerRows = Object.entries(byOppPlayer).map(([name,list])=>({ name, ...recordOf(list, mm=>mm.match_score_a>mm.match_score_b) }));
  oppPlayerRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);
  const oppPairRows = Object.entries(byOppPair).map(([name,list])=>({ name, ...recordOf(list, mm=>mm.match_score_a>mm.match_score_b) }));
  oppPairRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  const allFinishedForTrend = matches.filter(m => m.status==="finished" && oppOf(m)===schoolName);

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{schoolName}との対戦成績</span>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:40 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : (
          <>
            <PeriodSortBar period={period} setPeriod={setPeriod} sort={sort} setSort={setSort} />
            {finished.length===0 ? (
              <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この期間の対戦記録がありません</div>
            ) : (
              <>
                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>総合成績（自チーム視点）</div>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                    <div>
                      <div style={{ fontSize:20,fontWeight:800 }}>{rec.total}</div>
                      <div style={{ fontSize:11,color:C.textSec }}>試合数</div>
                    </div>
                    <div>
                      <div style={{ fontSize:20,fontWeight:800,color:C.accent }}>{rec.rate}%</div>
                      <div style={{ fontSize:11,color:C.textSec }}>勝率</div>
                    </div>
                    <div>
                      <div style={{ fontSize:20,fontWeight:800 }}>{rec.wins}勝{rec.losses}敗</div>
                      <div style={{ fontSize:11,color:C.textSec }}>戦績</div>
                    </div>
                  </div>
                </div>

                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>相手選手別の成績（自チームの勝率）</div>
                  {oppPlayerRows.map(r=>(
                    <div key={r.name} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}` }}>
                      <span style={{ fontSize:13 }}>{r.name}</span>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
                    </div>
                  ))}
                </div>

                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>相手ペア別の成績（自チームの勝率）</div>
                  {oppPairRows.map(r=>(
                    <div key={r.name} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}` }}>
                      <span style={{ fontSize:13 }}>{r.name}</span>
                      <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
                    </div>
                  ))}
                </div>

                <MonthlyTrendCard finishedMatches={allFinishedForTrend} winFn={m=>m.match_score_a>m.match_score_b} />

                <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:8 }}>試合一覧</div>
                {vsMatches.map(m=>{
                  const win = m.status==="finished" ? m.match_score_a>m.match_score_b : null;
                  const aP = m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
                  const bP = m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
                  return (
                    <div key={m.id} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                      <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                        <span style={{ fontSize:12,fontWeight:700 }}>{m.tournament_name||"試合"}</span>
                        <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(m.match_date)}</span>
                      </div>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:m.memo?6:0 }}>
                        <span style={{ fontSize:12,color:C.textSec }}>{aP} vs {bP}</span>
                        <span style={{ fontSize:14,fontWeight:800,color:m.status==="finished"?(win?C.teamA:C.teamB):C.textSec }}>
                          {matchStatusShortLabel(m)}
                        </span>
                      </div>
                      {m.memo && (
                        <div style={{ fontSize:11,color:C.navy,background:C.accentL,borderRadius:6,padding:"6px 8px",marginTop:4 }}>📝 {m.memo}</div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// セットアップ用 固定コンポーネント（関数外定義でフォーカスを保持）
// ============================================================
function FormSec({ title, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:11,fontWeight:700,color:C.navy,marginBottom:6,letterSpacing:"0.05em" }}>{title}</div>
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,overflow:"visible" }}>{children}</div>
    </div>
  );
}
function FormRow({ label, labelRight, children }) {
  return (
    <div style={{ padding:"10px 14px",borderBottom:`1px solid ${C.border}` }}>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4 }}>
        <label style={{ fontSize:11,color:C.textSec }}>{label}</label>
        {labelRight}
      </div>
      {children}
    </div>
  );
}

// schools（{name,prefecture}[] または {prefecture}を持つ配列）から、絞り込み候補の都道府県一覧を作る
function knownPrefsFrom(schools) {
  return Array.from(new Set(schools.map(s=>s.prefecture).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"ja"));
}

// ★学校名選択欄のラベル横に置く、小さな都道府県絞り込みプルダウン
function PrefMiniFilter({ value, onChange, options }) {
  if (options.length === 0) return null;
  return (
    <select
      value={value}
      onChange={e=>onChange(e.target.value)}
      style={{ fontSize:10,padding:"3px 6px",borderRadius:6,border:`1px solid ${C.border}`,background:C.white,color:C.textSec,maxWidth:130 }}
    >
      <option value="">都道府県で絞込み</option>
      {options.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

// 会場名入力＋候補サジェストコンポーネント
// 何回戦の選択肢（決め打ちリスト＋自由入力）
const ROUND_OPTIONS = [
  "1回戦","2回戦","3回戦","4回戦","5回戦","6回戦","7回戦","8回戦","9回戦",
  "準々決勝","準決勝","3位決定戦","決勝",
  "敗者復活1回戦","敗者復活2回戦","敗者復活3回戦","敗者復活4回戦","敗者復活5回戦",
];
function RoundField({ value, onChange, placeholder }) {
  const isPreset = ROUND_OPTIONS.includes(value);
  const [customMode, setCustomMode] = useState(!!value && !isPreset);
  return (
    <div>
      <select
        style={S.inp}
        value={customMode ? "__custom__" : (value || "")}
        onChange={e => {
          if (e.target.value === "__custom__") { setCustomMode(true); onChange(""); }
          else { setCustomMode(false); onChange(e.target.value); }
        }}
      >
        <option value="">リストから選択</option>
        {ROUND_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
        <option value="__custom__">✏️ 自由入力する</option>
      </select>
      {customMode && (
        <input
          style={{ ...S.inp, marginTop:8 }}
          placeholder={placeholder || "例：準々決勝"}
          value={value ?? ""}
          onChange={e => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function VenueField({ value, onChange, venues, placeholder }) {
  const safeValue = value ?? "";
  const safeVenues = venues ?? [];
  const filtered = safeValue.trim() ? safeVenues.filter(v => v.includes(safeValue.trim())) : safeVenues.slice(0, 5);
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position:"relative" }}>
      <input style={S.inp} placeholder={placeholder || "例：○○市民コート"} value={safeValue}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      {open && filtered.length > 0 && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, background:C.white, border:"1px solid "+C.border, borderRadius:8, zIndex:200, boxShadow:"0 4px 16px rgba(0,0,0,0.15)", maxHeight:200, overflowY:"auto" }}>
          {filtered.map(v => (
            <div key={v} style={{ padding:"12px 14px", fontSize:13, color:C.text, borderBottom:"1px solid "+C.border, cursor:"pointer", background:C.white }}
              onMouseDown={e => { e.preventDefault(); onChange(v); setOpen(false); }}
            >{v}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ★学校名の誤入力防止用：入力しながら候補が絞り込まれるサジェスト式の入力欄
// schools は {name, prefecture}[] 形式（prefectureはnullの場合あり）
// prefFilter: 親から渡される都道府県絞り込み値（任意）
function SchoolField({ value, onChange, schools, placeholder, prefFilter }) {
  const [open, setOpen] = useState(false);
  const safeValue = value || "";
  const visibleSchools = prefFilter ? schools.filter(s => s.prefecture === prefFilter) : schools;
  const q = safeValue.trim();
  const filtered = q ? visibleSchools.filter(s => s.name.includes(q)) : visibleSchools;

  return (
    <div style={{ position:"relative" }}>
      <input
        style={S.inp}
        placeholder={placeholder}
        value={safeValue}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      {open && filtered.length > 0 && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, background:C.white, border:"1px solid "+C.border, borderRadius:8, zIndex:200, boxShadow:"0 4px 16px rgba(0,0,0,0.15)", maxHeight:220, overflowY:"auto", WebkitOverflowScrolling:"touch", overscrollBehavior:"contain", touchAction:"pan-y" }}>
          <div style={{ padding:"4px 14px", fontSize:10, color:C.textSec, background:"#f5f6f8" }}>{filtered.length}件中 最大200件を表示（枠内をスクロールできます）</div>
          {filtered.slice(0, 200).map(s => (
            <div key={s.name} style={{ padding:"12px 14px", fontSize:13, color:C.text, borderBottom:"1px solid "+C.border, cursor:"pointer", background:C.white }}
              onMouseDown={e => { e.preventDefault(); onChange(s.name); setOpen(false); }}
            >{s.name}{s.prefecture ? `（${s.prefecture}）` : ""}</div>
          ))}
        </div>
      )}
      {value && (
        <div style={{ fontSize:11, color:C.textSec, marginTop:4 }}>✎ 「{value}A」のように自由に文字を足すこともできます</div>
      )}
    </div>
  );
}

// ★プロフィール・新規登録用：学校マスターから選ぶだけ（自由入力不可、管理者のみがマスターを編集できる）
// prefFilter: 親から渡される都道府県絞り込み値（任意）
function SchoolIdSelect({ value, onChange, schools, prefFilter, genderCategory }) {
  if (schools.length === 0) {
    return (
      <div style={{ fontSize:12,color:C.textSec,padding:"10px 0" }}>
        学校がまだ登録されていません。管理者に学校の追加を依頼してください。
      </div>
    );
  }

  const visibleSchools = schools
    .filter(s => !prefFilter || s.prefecture === prefFilter)
    .filter(s => schoolMatchesGender(s, genderCategory));

  return (
    <select
      style={{ ...S.inp, background:"transparent" }}
      value={value || ""}
      onChange={e=>onChange(e.target.value || null)}
    >
      <option value="">選択してください</option>
      {visibleSchools.map(s => {
        const tags = [categoryLabel(s.category), s.prefecture].filter(Boolean).join("・");
        return <option key={s.id} value={s.id}>{s.name}{tags ? `（${tags}）` : ""}</option>;
      })}
    </select>
  );
}

// ============================================================
// 試合セットアップ
// ============================================================
function MatchSetup({ onSave, onCancel, sourceMatchId, editMatchId, initialMatchType, onScheduled, headerLabel, prefillTournament, prefillRound, prefillVenue, prefillDate, prefillOpponent, prefillIsYounger, isTeamMatchGame, teamMatchMyDivision, teamMatchOppDivision, teamMatchMySchoolId, onSavePairOnly, lockTournament, tournamentStartDate, tournamentEndDate }) {
  const [ready, setReady] = useState(!editMatchId && !sourceMatchId);
  const [editing, setEditing] = useState(null);
  const [source,  setSource]  = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [e, s] = await Promise.all([
          editMatchId ? getMatch(editMatchId) : Promise.resolve(null),
          sourceMatchId ? getMatch(sourceMatchId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setEditing(e); setSource(s); setReady(true);
      } catch (err) {
        if (cancelled) return;
        alert("試合データの読み込みに失敗しました。もう一度お試しください。\n" + (err.message || err));
        onCancel && onCancel();
      }
    }
    load();
    return () => { cancelled = true; };
  }, [editMatchId, sourceMatchId]);

  if (!ready) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }
  return <MatchSetupForm onSave={onSave} onCancel={onCancel} editing={editing} source={source} initialMatchType={initialMatchType} onScheduled={onScheduled} headerLabel={headerLabel} prefillTournament={prefillTournament} prefillRound={prefillRound} prefillVenue={prefillVenue} prefillDate={prefillDate} prefillOpponent={prefillOpponent} prefillIsYounger={prefillIsYounger} isTeamMatchGame={isTeamMatchGame} teamMatchMyDivision={teamMatchMyDivision} teamMatchOppDivision={teamMatchOppDivision} teamMatchMySchoolId={teamMatchMySchoolId} onSavePairOnly={onSavePairOnly} lockTournament={lockTournament} tournamentStartDate={tournamentStartDate} tournamentEndDate={tournamentEndDate} />;
}

function MatchSetupForm({ onSave, onCancel, editing, source, initialMatchType, onScheduled, headerLabel, prefillTournament, prefillRound, prefillVenue, prefillDate, prefillOpponent, prefillIsYounger, isTeamMatchGame, teamMatchMyDivision, teamMatchOppDivision, teamMatchMySchoolId, onSavePairOnly, lockTournament, tournamentStartDate, tournamentEndDate }) {
  const base    = editing || source;

  // 試合開始済み（active/finished）の場合のみ形式設定をロック
  // 予定（scheduled）は編集可能
  const locked = !!editing && (editing.status === "active" || editing.status === "finished");

  const aBase = base ? base.players.find(p=>p.team==="A") : null;
  const aBase2 = base ? base.players.find(p=>p.team==="A" && p.order_num===2) : null;
  const bBase = base ? base.players.find(p=>p.team==="B") : null;
  const bBase2 = base ? base.players.find(p=>p.team==="B" && p.order_num===2) : null;

  // ★各フィールドを独立したstateに分離（フォーカス維持のため）
  const [matchDate,      setMatchDate]      = useState(base?.match_date ?? prefillDate ?? today());
  const [venue,          setVenue]          = useState(base?.venue ?? prefillVenue ?? "");
  const [tournamentName, setTournamentName] = useState(base?.tournament_name ?? prefillTournament ?? "");
  const [round,          setRound]          = useState(base?.round ?? prefillRound ?? "");
  const [matchType,      setMatchType]      = useState(base?.match_type ?? initialMatchType ?? "tournament");
  const [courtNumber,    setCourtNumber]    = useState(base?.court_number ?? "");
  const [isYounger,      setIsYounger]      = useState(base ? (base?.is_younger !== false ? true : false) : (prefillIsYounger !== undefined ? prefillIsYounger : null));
  const [gameFormat,     setGameFormat]     = useState(base?.game_format ?? 7);
  const [isDoubles,      setIsDoubles]      = useState(base?.is_doubles ?? true);
  const [firstServer,    setFirstServer]    = useState(base?.first_server ?? null);
  const [aClub,  setAClub]  = useState(aBase?.club_name ?? "");
  const [aP1,    setAP1]    = useState(aBase?.player_name ?? "");
  const [aP2,    setAP2]    = useState(aBase2?.player_name ?? "");
  const [bClub,  setBClub]  = useState(bBase?.club_name ?? prefillOpponent ?? "");
  const [bP1,    setBP1]    = useState(bBase?.player_name ?? "");
  const [bP2,    setBP2]    = useState(bBase2?.player_name ?? "");

  const isScheduledEdit = editing?.status === "scheduled";
  const canSave = aP1.trim() && (!isDoubles || aP2.trim()) && bP1.trim() && (!isDoubles || bP2.trim()) && isYounger !== null;

  const [saving, setSaving] = useState(false);
  const [scheduledId, setScheduledId] = useState(editing?.status==="scheduled" ? editing.id : null); // 予定登録済みのID
  const [serveSelectForSave, setServeSelectForSave] = useState(null);
  const [showMatchInfo, setShowMatchInfo] = useState(false); // 試合情報の表示/非表示（デフォルト：非表示）

  // ★選手マスター（同じ学校のメンバーで共有）を読み込み、入力時にチップで選べるようにする
  const [roster, setRoster] = useState([]);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);
  // 自チーム・相手チームとも team_name で絞り込む（同じ仕様）
  const ownRosterAll = roster; // チップ表示時に team_name で絞る
  const oppRosterBase = roster;
  // 同校対決：相手チームが自チームと同じ学校名の場合、自チームの選手もチップに表示
  const isSameSchool = aClub && bClub && aClub.trim() === bClub.trim();
  const ownRosterLocal = roster.filter(p => p.is_own_team !== false);
  const oppRoster = isSameSchool
    ? [...ownRosterLocal, ...oppRosterBase.filter(p => p.team_name === bClub && p.is_own_team === false)]
    : oppRosterBase;

  // ★学校名の候補一覧（誤入力防止）
  const [schools, setSchools] = useState([]);
  useEffect(() => { getKnownSchools().then(setSchools); }, []);

  // ★会場名の候補一覧
  const [venues, setVenues] = useState([]);
  useEffect(() => { getKnownVenues().then(setVenues); }, []);

  // ★この試合がドローの枠から作られたものであれば、エントリー番号もここで一緒に編集できるようにする
  const [drawLink, setDrawLink] = useState(null); // { id, side_a_entry_id, side_b_entry_id }
  const [aEntryNo, setAEntryNo] = useState("");
  const [bEntryNo, setBEntryNo] = useState("");
  useEffect(() => {
    if (!editing?.id) return;
    getDrawMatchByMatchId(editing.id).then(async (link) => {
      if (!link) return;
      setDrawLink(link);
      const ids = [link.side_a_entry_id, link.side_b_entry_id].filter(Boolean);
      if (ids.length) {
        const { data } = await supabase.from("draw_entries").select("id, entry_no").in("id", ids);
        (data || []).forEach(row => {
          if (row.id === link.side_a_entry_id) setAEntryNo(row.entry_no != null ? String(row.entry_no) : "");
          if (row.id === link.side_b_entry_id) setBEntryNo(row.entry_no != null ? String(row.entry_no) : "");
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  // ★チーム名/学校名の都道府県絞り込み（自チーム・相手チームそれぞれ独立）
  const [aClubPref, setAClubPref] = useState("");
  const [bClubPref, setBClubPref] = useState("");

  // ★自チーム学校名の初期化
  // 団体戦ペア登録時はteamMatchMySchoolIdを優先、通常はプロフィールの学校名
  useEffect(() => {
    if (base) return; // 編集・コピー時は既存のチーム名をそのまま使う
    (async () => {
      const allSchools = await getSchools();
      if (isTeamMatchGame && teamMatchMySchoolId) {
        const mine = allSchools.find(s => s.id === teamMatchMySchoolId);
        if (mine) { setAClub(mine.name); return; }
      }
      const profile = await getMyProfile();
      if (!profile?.school_id) return;
      const mine = allSchools.find(s => s.id === profile.school_id);
      if (mine) setAClub(prev => prev || mine.name);
    })();
  }, []);

  // ★本当の自チーム名（プロフィール上の所属校）を別途保持しておく。
  //   「自チーム(A)」「相手チーム(B)」どちらの欄に自チーム名を入れても、
  //   保存時に自チームが必ずチームA（緑）になるようにするための判定に使う。
  const [ownSchoolName, setOwnSchoolName] = useState("");
  useEffect(() => {
    (async () => {
      const allSchools = await getSchools();
      if (isTeamMatchGame && teamMatchMySchoolId) {
        const mine = allSchools.find(s => s.id === teamMatchMySchoolId);
        if (mine) { setOwnSchoolName(mine.name); return; }
      }
      const profile = await getMyProfile();
      if (!profile?.school_id) return;
      const mine = allSchools.find(s => s.id === profile.school_id);
      if (mine) setOwnSchoolName(mine.name);
    })();
  }, []);

  // 自チーム選手の入力チェック
  const canSchedule = aP1.trim() && (!isDoubles || aP2.trim()) && isYounger !== null;

  async function handleSchedule() {
    // 2回目以降は確認ポップアップ
    if (scheduledId) {
      if (!window.confirm("予定情報を更新しますか？")) return;
    }
    setSaving(true);
    try {
      const mid = scheduledId || uid();
      // ★自チームが誤って「相手チーム(B)」欄に入力されていた場合、保存時に必ずチームA（緑）になるよう入れ替える
      const swap = ownSchoolName && bClub.trim() === ownSchoolName && aClub.trim() !== ownSchoolName;
      const fAClub = swap ? bClub : aClub, fAP1 = swap ? bP1 : aP1, fAP2 = swap ? bP2 : aP2;
      const fBClub = swap ? aClub : bClub, fBP1 = swap ? aP1 : bP1, fBP2 = swap ? aP2 : bP2;
      const fFirstServer = swap ? (firstServer === "A" ? "B" : firstServer === "B" ? "A" : firstServer) : firstServer;
      const players = [
        { id:uid(), match_id:mid, team:"A", player_name:fAP1.trim(), club_name:fAClub.trim(), position:null, order_num:1 },
        ...(isDoubles && fAP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:fAP2.trim(), club_name:fAClub.trim(), position:null, order_num:2 }] : []),
        ...(fBP1.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:fBP1.trim(), club_name:fBClub.trim(), position:null, order_num:1 }] : []),
        ...(isDoubles && fBP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:fBP2.trim(), club_name:fBClub.trim(), position:null, order_num:2 }] : []),
      ];
      const match = {
        id:mid, created_by:"me",
        match_date:matchDate, venue, tournament_name:tournamentName, round,
        match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server:fFirstServer,
        status:"scheduled", match_score_a:0, match_score_b:0, memo:"", court_number:courtNumber||null, is_younger:isYounger, players, games:[],
      };
      await saveMatch(match);
      setScheduledId(mid);
      onScheduled && onScheduled();
    } catch(e) {
      alert("登録に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }


  // サーブ選択ポップアップ → handleSave本体を呼ぶ
  function handleSaveWithServeSelect() {
    if (isYounger === null || isYounger === undefined) { alert("若番／遅番を選択してください"); return; }
    if (editing) { handleSave(null); return; } // 編集時はサーブ選択不要
    // ★自チームが「相手チーム(B)」欄に入力されていても、保存時にチームAへ入れ替えるのに合わせて、
    //   このサーブ選択画面でも自チームが必ず緑（A）側に表示されるようにする
    const swap = ownSchoolName && bClub.trim() === ownSchoolName && aClub.trim() !== ownSchoolName;
    const aLabel = (swap
      ? [bP1.trim(), isDoubles ? bP2.trim() : ""]
      : [aP1.trim(), isDoubles ? aP2.trim() : ""]).filter(Boolean).join("/") || "自チーム";
    const bLabel = (swap
      ? [aP1.trim(), isDoubles ? aP2.trim() : ""]
      : [bP1.trim(), isDoubles ? bP2.trim() : ""]).filter(Boolean).join("/") || "相手チーム";
    setServeSelectForSave({ aLabel, bLabel });
  }

  async function handleSave(selectedServer) {
    setSaving(true);
    try {
      if (editing) {
        // 既存試合の試合情報・選手情報のみ更新（スコア・ゲームは変更しない）
        const updatedPlayers = [
          { id: aBase?.id ?? uid(), match_id: editing.id, team:"A", player_name:aP1.trim(), club_name:aClub.trim(), position:aBase?.position ?? null, order_num:1 },
          ...(isDoubles && aP2.trim() ? [{ id: aBase2?.id ?? uid(), match_id: editing.id, team:"A", player_name:aP2.trim(), club_name:aClub.trim(), position:aBase2?.position ?? null, order_num:2 }] : []),
          { id: bBase?.id ?? uid(), match_id: editing.id, team:"B", player_name:bP1.trim(), club_name:bClub.trim(), position:bBase?.position ?? null, order_num:1 },
          ...(isDoubles && bP2.trim() ? [{ id: bBase2?.id ?? uid(), match_id: editing.id, team:"B", player_name:bP2.trim(), club_name:bClub.trim(), position:bBase2?.position ?? null, order_num:2 }] : []),
        ];
        const updated = {
          ...editing,
          match_date:matchDate, venue, tournament_name:tournamentName, round, match_type:matchType, court_number:courtNumber||null,
          players: updatedPlayers,
          // 予定の場合は形式設定も更新可能
          ...((editing.status === "scheduled" || editing.status === "waiting") ? { game_format:gameFormat, is_doubles:isDoubles, first_server:firstServer, is_younger:isYounger } : { is_younger:isYounger }),
        };
        await saveMatch(updated);
        if (drawLink) {
          await Promise.all([
            updateDrawEntryNo(drawLink.side_a_entry_id, aEntryNo.trim()),
            updateDrawEntryNo(drawLink.side_b_entry_id, bEntryNo.trim()),
          ]);
        }
        onSave(editing.id);
        return;
      }

      // 新規作成 or コピー作成
      const mid = uid();
      // ★自チームが誤って「相手チーム(B)」欄に入力されていた場合、保存時に必ずチームA（緑）になるよう入れ替える
      const swap = ownSchoolName && bClub.trim() === ownSchoolName && aClub.trim() !== ownSchoolName;
      const fAClub = swap ? bClub : aClub, fAP1 = swap ? bP1 : aP1, fAP2 = swap ? bP2 : aP2;
      const fBClub = swap ? aClub : bClub, fBP1 = swap ? aP1 : bP1, fBP2 = swap ? aP2 : bP2;
      const fServer = selectedServer;
      const fFirstServer = swap ? (firstServer === "A" ? "B" : firstServer === "B" ? "A" : firstServer) : firstServer;
      const players = [
        { id:uid(), match_id:mid, team:"A", player_name:fAP1.trim(), club_name:fAClub.trim(), position:null, order_num:1 },
        ...(isDoubles && fAP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:fAP2.trim(), club_name:fAClub.trim(), position:null, order_num:2 }] : []),
        { id:uid(), match_id:mid, team:"B", player_name:fBP1.trim(), club_name:fBClub.trim(), position:null, order_num:1 },
        ...(isDoubles && fBP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:fBP2.trim(), club_name:fBClub.trim(), position:null, order_num:2 }] : []),
      ];
      const match = {
        id:mid, created_by:"me",
        match_date:matchDate, venue, tournament_name:tournamentName, round,
        match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server:fServer || fFirstServer || "A",
        status:"active", match_score_a:0, match_score_b:0, memo:"", court_number:courtNumber||null, is_younger:isYounger, players, games:[],
      };
      await saveMatch(match);
      // 選手マスターに自動登録（直接入力された選手のみ。マスター未登録の場合）
      const autoRegisterTasks = [
        autoRegisterPlayerToRoster(fAP1.trim(), fAClub.trim(), true),
        ...(isDoubles && fAP2.trim() ? [autoRegisterPlayerToRoster(fAP2.trim(), fAClub.trim(), true)] : []),
        autoRegisterPlayerToRoster(fBP1.trim(), fBClub.trim(), false),
        ...(isDoubles && fBP2.trim() ? [autoRegisterPlayerToRoster(fBP2.trim(), fBClub.trim(), false)] : []),
      ];
      await Promise.all(autoRegisterTasks);
      onSave(mid);
    } catch (e) {
      alert("保存エラー: " + JSON.stringify({msg: e?.message, code: e?.code, details: e?.details, hint: e?.hint}));
    } finally {
      setSaving(false);
    }
  }

  // ★自チーム(A)の選手候補チップ：選択中の「チーム名/学校名」(aClub)と一致する選手のみ表示する。
  //   aClubを東福岡から別のチームに変えたら候補もそのチームの選手に切り替わるようにする。
  const ownRosterForA = roster.filter(p => aClub ? p.team_name === aClub : p.is_own_team !== false);

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onCancel}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{headerLabel || (editing?"試合情報を編集":source?"試合をコピー":"新規試合")}</span>
        </div>
      </div>
      {source && (
        <div style={{ background:"#fff8e6",borderBottom:"1px solid #f5d99b",padding:"10px 14px",fontSize:12,color:"#7a5800" }}>
          📋 「{source.tournament_name || "前の試合"}」の情報をコピーしました。内容を確認・変更してください（スコアはコピーされません）。
        </div>
      )}
      {locked && (
        <div style={{ background:"#f5f5f5",borderBottom:"1px solid #e0e0e0",padding:"10px 14px",fontSize:12,color:C.textSec }}>
          ✏️ 試合情報・選手名を編集できます。ゲーム数・種目・サーブ順は試合開始後のため変更できません。
        </div>
      )}
      <div style={{ padding:14 }}>

        {/* 団体戦ペア登録モード：試合情報を非表示 */}
        {!isTeamMatchGame && (
          <>
        <div style={{ marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <span style={{ fontSize:11,fontWeight:700,color:C.navy,letterSpacing:"0.05em" }}>試合情報</span>
            <button
              style={{ background:"#eef0f4", border:"none", borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, color:C.navy, cursor:"pointer" }}
              onClick={() => setShowMatchInfo(v => !v)}
            >
              {showMatchInfo ? "非表示 ▲" : "表示 ▼"}
            </button>
          </div>
          {showMatchInfo && (
          <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,overflow:"visible" }}>
          <FormRow label="大会名">
            {lockTournament ? (
              <div style={{ ...S.inp, display:"flex", justifyContent:"space-between", alignItems:"center", fontWeight:700 }}>
                <span>{tournamentName}</span>
                <span style={{ fontSize:12, color:C.textSec, background:"#e2e5eb", padding:"4px 6px", borderRadius:10, fontWeight:700 }}>🔒</span>
              </div>
            ) : (
              <input style={S.inp} placeholder="例：○○中学校選手権" value={tournamentName} onChange={e => setTournamentName(e.target.value)}/>
            )}
          </FormRow>
          <FormRow label="試合日">
            {lockTournament && tournamentStartDate && tournamentEndDate && tournamentStartDate !== tournamentEndDate ? (
              <div>
                <input type="date" style={S.inp} value={matchDate} min={tournamentStartDate} max={tournamentEndDate} onChange={e => setMatchDate(e.target.value)}/>
                <div style={{ fontSize:10, color:C.textSec, marginTop:4 }}>📅 大会期間（{fmtDate(tournamentStartDate)}〜{fmtDate(tournamentEndDate)}）内から選択できます</div>
              </div>
            ) : lockTournament ? (
              <div style={{ ...S.inp, display:"flex", justifyContent:"space-between", alignItems:"center", fontWeight:700 }}>
                <span>{fmtDate(matchDate)}</span>
                <span style={{ fontSize:10, color:C.textSec, background:"#e2e5eb", padding:"2px 8px", borderRadius:10, fontWeight:700 }}>🔒 大会の日程</span>
              </div>
            ) : (
              <input type="date" style={S.inp} value={matchDate} onChange={e => setMatchDate(e.target.value)}/>
            )}
          </FormRow>
          <FormRow label="場所 / 会場名">
            <VenueField value={venue} onChange={setVenue} venues={venues} />
          </FormRow>
          <FormRow label="ゲーム数（デフォルト：7G）">
            {locked ? (
              <div style={{ fontSize:14,fontWeight:700,color:C.textSec,padding:"4px 0" }}>{gameFormat}G 🔒</div>
            ) : (
              <div style={{ display:"flex",gap:8 }}>
                {GAME_FORMATS.map(v => (
                  <button key={v} style={S.togBtn(gameFormat===v)} onClick={() => setGameFormat(v)}>{v}G</button>
                ))}
              </div>
            )}
          </FormRow>
          <FormRow label="種目">
            {locked ? (
              <div style={{ fontSize:14,fontWeight:700,color:C.textSec,padding:"4px 0" }}>{isDoubles?"ダブルス":"シングルス"} 🔒</div>
            ) : (
              <div style={{ display:"flex",gap:8 }}>
                {[["ダブルス",true],["シングルス",false]].map(([l,v]) => (
                  <button key={l} style={S.togBtn(isDoubles===v)} onClick={() => setIsDoubles(v)}>{l}</button>
                ))}
              </div>
            )}
          </FormRow>
          </div>
          )}
        </div>
          </>
        )}

        {/* 団体戦ペア登録モード：チーム区分・相手校を表示のみ */}
        {isTeamMatchGame && (
          <div style={{ ...S.card, padding:"10px 14px", marginBottom:14, background:"#f0f4ff", border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:4 }}>自チーム区分</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.navy,marginBottom:8 }}>{teamMatchMyDivision || "（なし）"}</div>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:4 }}>相手チーム</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.navy }}>{prefillOpponent || "（未設定）"}{teamMatchOppDivision ? `（${teamMatchOppDivision}）` : ""}</div>
          </div>
        )}

        <FormSec title="自チーム (A)">
          {drawLink && (
            <FormRow label="エントリー番号">
              <input style={S.inp} placeholder="例：12" inputMode="numeric" value={aEntryNo} onChange={e => setAEntryNo(e.target.value)}/>
            </FormRow>
          )}
          <FormRow label="チーム名 / 学校名" labelRight={isTeamMatchGame ? null : <PrefMiniFilter value={aClubPref} onChange={setAClubPref} options={knownPrefsFrom(schools)} />}>
            {isTeamMatchGame ? (
              <div style={{ ...S.inp, color:C.text, background:C.gray }}>{aClub || "（自チーム）"}</div>
            ) : (
              <SchoolField value={aClub} onChange={setAClub} schools={schools} placeholder="例：○○中学校" prefFilter={aClubPref} />
            )}
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={aP1} onChange={e => setAP1(e.target.value)}/>
            {ownRosterForA.length>0 && (
              <div style={{ marginTop:6 }}>
                {ownRosterForA.map(p=>(
                  <span key={p.id} style={S.chip(aP1===p.player_name)} onClick={()=>setAP1(p.player_name)}>{p.player_name}</span>
                ))}
              </div>
            )}
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={aP2} onChange={e => setAP2(e.target.value)}/>
              {ownRosterForA.length>0 && (
                <div style={{ marginTop:6 }}>
                  {ownRosterForA.map(p=>(
                    <span key={p.id} style={S.chip(aP2===p.player_name)} onClick={()=>setAP2(p.player_name)}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
          )}
        </FormSec>

        <FormSec title="相手チーム (B)">
          {drawLink && (
            <FormRow label="エントリー番号">
              <input style={S.inp} placeholder="例：13" inputMode="numeric" value={bEntryNo} onChange={e => setBEntryNo(e.target.value)}/>
            </FormRow>
          )}
          <FormRow label="チーム名 / 学校名" labelRight={isTeamMatchGame ? null : <PrefMiniFilter value={bClubPref} onChange={setBClubPref} options={knownPrefsFrom(schools)} />}>
            {isTeamMatchGame ? (
              <div style={{ ...S.inp, color:C.text, background:C.gray }}>{bClub || prefillOpponent || "（相手チーム）"}</div>
            ) : (
              <SchoolField value={bClub} onChange={setBClub} schools={schools} placeholder="例：相手チーム名" prefFilter={bClubPref} />
            )}
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={bP1} onChange={e => setBP1(e.target.value)}/>
            {bClub && oppRoster.filter(p => p.team_name === bClub).length>0 && (
              <div style={{ marginTop:6 }}>
                {oppRoster.filter(p => p.team_name === bClub).map(p=>(
                  <span key={p.id} style={S.chip(bP1===p.player_name)} onClick={()=>setBP1(p.player_name)}>{p.player_name}</span>
                ))}
              </div>
            )}
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={bP2} onChange={e => setBP2(e.target.value)}/>
              {bClub && oppRoster.filter(p => p.team_name === bClub).length>0 && (
                <div style={{ marginTop:6 }}>
                  {oppRoster.filter(p => p.team_name === bClub).map(p=>(
                    <span key={p.id} style={S.chip(bP2===p.player_name)} onClick={()=>setBP2(p.player_name)}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
          )}
          {oppRoster.length===0 && (
            <div style={{ padding:"0 14px 12px",fontSize:11,color:C.textSec }}>
              マスター画面の「👥 選手マスター」(他チーム)で対戦相手の選手を登録しておくと、ここで選んで入力できます。
            </div>
          )}
        </FormSec>

        <FormSec title="試合詳細">
          <FormRow label="何回戦（任意）">
            <RoundField value={round} onChange={setRound} placeholder="例：準々決勝"/>
          </FormRow>
          <FormRow label="コート番号（任意）">
            <input style={S.inp} placeholder="例：3番コート" value={courtNumber} onChange={e => setCourtNumber(e.target.value)}/>
          </FormRow>
          {!isTeamMatchGame && (
            <FormRow label="若番 / 遅番（必須）">
              <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>自チームはトーナメント表のどちら側ですか？</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                <button style={S.togBtn(isYounger===true, C.navy)} onClick={()=>setIsYounger(true)}>若番</button>
                <button style={S.togBtn(isYounger===false, C.navy)} onClick={()=>setIsYounger(false)}>遅番</button>
              </div>
            </FormRow>
          )}
        </FormSec>

        <button
          style={{ ...S.btn((canSave&&!saving) ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border, (canSave&&!saving) ? C.white : C.textSec), marginTop:4, marginBottom:8 }}
          disabled={!canSave || saving}
          onClick={editing ? ()=>handleSave(null) : handleSaveWithServeSelect}
        >
          {saving ? "保存中..." : (editing ? "保存する 💾" : isTeamMatchGame ? "ペアを登録して試合開始 🎾" : "試合を開始する 🎾")}
        </button>
        {/* 団体戦ペア登録モード：ペアだけ保存して戻るボタン */}
        {isTeamMatchGame && onSavePairOnly && (
          <button
            style={{ ...S.btn(canSave && !saving ? C.navy : C.border, canSave && !saving ? C.white : C.textSec), marginTop:4, marginBottom:8 }}
            disabled={!canSave || saving}
            onClick={async ()=>{
              setSaving(true);
              try {
                const mid = uid();
                const players = [
                  { id:uid(), match_id:mid, team:"A", player_name:aP1.trim(), club_name:aClub.trim(), position:null, order_num:1 },
                  ...(isDoubles && aP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:aP2.trim(), club_name:aClub.trim(), position:null, order_num:2 }] : []),
                  { id:uid(), match_id:mid, team:"B", player_name:bP1.trim(), club_name:bClub.trim(), position:null, order_num:1 },
                  ...(isDoubles && bP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:bP2.trim(), club_name:bClub.trim(), position:null, order_num:2 }] : []),
                ];
                const match = {
                  id:mid, created_by:"me",
                  match_date:matchDate, venue, tournament_name:tournamentName, round,
                  match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server: "A",
                  status:"scheduled", match_score_a:0, match_score_b:0, memo:"", court_number:courtNumber||null, is_younger:isYounger, players, games:[],
                };
                await saveMatch(match);
                onSavePairOnly(mid, { aP1: aP1.trim(), aP2: aP2.trim(), bP1: bP1.trim(), bP2: bP2.trim() });
              } catch(e) {
                alert("保存エラー: " + (e.message || e));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中..." : "💾 ペアを登録して戻る"}
          </button>
        )}
        {!editing && !isTeamMatchGame && (
          <button
            style={{ ...S.btn(canSchedule ? "linear-gradient(135deg,#7b1fa2,#9c27b0)" : C.border, canSchedule ? C.white : C.textSec), marginTop:4 }}
            disabled={!canSchedule || saving}
            onClick={handleSchedule}
          >
            {saving ? "登録中..." : scheduledId ? "📅 試合予定を更新する" : "📅 試合予定として登録する"}
          </button>
        )}
      </div>

      {/* サーブ選択モーダル */}
      {serveSelectForSave && (
        <Modal onClose={()=>setServeSelectForSave(null)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
            <h3 style={{ fontSize:16, fontWeight:800, margin:"8px 0 4px" }}>最初のサーブを選択</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:16 }}>どちらがサーブから始めますか？</p>
            <div style={{ display:"flex", gap:10, marginBottom:12 }}>
              {[["A", serveSelectForSave.aLabel], ["B", serveSelectForSave.bLabel]].map(([team, label]) => (
                <button key={team}
                  style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?"#2ecc71":"#f97316"}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?"#2ecc71":"#f97316" }}
                  onClick={()=>{ setServeSelectForSave(null); handleSave(team); }}
                >{label}<br/><span style={{ fontSize:11, fontWeight:400 }}>（サーブ）</span></button>
              ))}
            </div>
            <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:12 }} onClick={()=>setServeSelectForSave(null)}>キャンセル</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// スコア記録
// ============================================================
function ScoreRecord({ matchId, onBack, onEdit, onNavigate, teamMatchId }) {
  const [initialMatch, setInitialMatch] = useState(null);
  const [loadKey, setLoadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [viewOnly, setViewOnly] = useState(false); // 観戦モード

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const m = await getMatch(matchId);
      setInitialMatch(m);
    } catch (e) {
      alert("更新に失敗しました。もう一度お試しください。\n" + (e?.message || e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, { data: { user } }] = await Promise.all([
          getMatch(matchId),
          supabase.auth.getUser(),
        ]);
        if (cancelled) return;
        setInitialMatch(m);
        if (m && user) {
          if (teamMatchId) {
            // 団体戦：team_match_gamesのrecorder_idと自分のIDを比較
            const { data: tmg } = await supabase
              .from("team_match_games")
              .select("recorder_id, status")
              .eq("match_id", matchId)
              .single();
            // recorder_idが設定されていて自分以外 → 観戦モード
            // recorder_idがnull（誰も記録していない）→ 観戦モード（スコア詳細から入った場合）
            // ★毎回true/falseを確定させる（一度観戦モードになった後、自分が記録者になっても
            // 　falseに戻らなかったバグがあったため）
            setViewOnly(!tmg || !tmg.recorder_id || tmg.recorder_id !== user.id);
          } else {
            // 個人戦：作成者以外は観戦モード
            setViewOnly(m.created_by !== user.id);
          }
        }
      } catch(e) {
        if (!cancelled) alert("試合読み込みエラー: " + (e?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [matchId, loadKey]);

  if (!initialMatch) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }
  return (
    <ErrorBoundary>
      <ScoreRecordInner
        key={initialMatch.id}
        initialMatch={initialMatch}
        onBack={onBack}
        onEdit={onEdit}
        onReload={()=>setLoadKey(k=>k+1)}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onNavigate={onNavigate}
        viewOnly={viewOnly}
        teamMatchId={teamMatchId}
      />
    </ErrorBoundary>
  );
}

function ScoreRecordInner({ initialMatch, onBack, onEdit, onReload, onRefresh, refreshing, onNavigate, viewOnly, teamMatchId }) {
  const [match,  setMatch]  = useState(initialMatch);
  const [tab,    setTab]    = useState("record");
  const [fault,  setFault]  = useState(0);
  const [modal,  setModal]  = useState(null);
  const [serveSelectModal, setServeSelectModal] = useState(false); // サーブ選択モーダル
  // 4段階選択状態
  const [selPlay,   setSelPlay]   = useState(null);   // プレイ内容
  const [selSide,   setSelSide]   = useState(null);   // フォア / バック
  const [selResult, setSelResult] = useState(null);   // 結果
  const [selPlayer, setSelPlayer] = useState(null);   // 選手（表示名・記録用）
  const [selPlayerId, setSelPlayerId] = useState(null); // 選手（チップ選択状態の判定用・一意ID）
  // ★得点入力ウィザード（①どちらに1点→②決めた/相手ミス→③誰が、の3タップ）
  const [scoreStep, setScoreStep] = useState(1); // 1|2|3
  const [pendingTeam, setPendingTeam] = useState(null); // ①で選んだ得点チーム
  const [correctMode, setCorrectMode] = useState(false); // 試合終了後のスコア修正モード
  const [editingPoint, setEditingPoint] = useState(null); // 修正中のポイント { gameId, point }
  const [addingPoint, setAddingPoint] = useState(null); // 追加位置 { gameId, atIndex }
  const [memoDraft, setMemoDraft] = useState(initialMatch.memo || ""); // 試合メモ（下書き）
  const [memoSaved, setMemoSaved] = useState(true); // メモが保存済みかどうか
  const [suspendConfirm, setSuspendConfirm] = useState(false); // 中断確認ダイアログ
  const [abandonConfirm, setAbandonConfirm] = useState(false); // 途中終了確認ダイアログ
  const [undoConfirm, setUndoConfirm] = useState(false); // 1点前に戻す確認ダイアログ
  const [resetConfirm, setResetConfirm] = useState(false); // スコアリセット確認ダイアログ

  // ★保存処理を1件ずつ順番に実行するためのキュー（連打しても保存が衝突しないように）
  const saveQueueRef = useRef(Promise.resolve());
  const persist = useCallback((m)=>{
    setMatch({...m});
    saveQueueRef.current = saveQueueRef.current
      .then(()=>saveMatch(m))
      .catch(e=>alert("保存に失敗しました: "+(e.message||e)));
  },[]);
  const winGames = calcWinGames(match.game_format);
  const currentGame = match.games.length>0&&!match.games[match.games.length-1].winner_team ? match.games[match.games.length-1] : null;
  const currentGameIsFinal = currentGame ? currentGame.is_final : isFinalGame(match.game_format,match.match_score_a,match.match_score_b);
  const nonFaultPts = currentGame?.points??[];
  const curServer = currentGame ? (currentGame.is_final ? finalServer(currentGame.server_team,nonFaultPts.length) : currentGame.server_team) : null;
  // ★サーブ表示：2ポイントごとの交代ルールを反映し、今まさにサーブする「個人」を出す
  const curServerPlayers = curServer ? match.players.filter(p=>p.team===curServer).sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name) : [];
  const curServeTurn = currentGame ? (currentGameIsFinal
    ? nonFaultPts.filter((_,i)=>finalServer(currentGame.server_team,i)===curServer).length
    : nonFaultPts.length) : 0;
  const curServerIndividual = curServerPlayers.length<=1 ? (curServerPlayers[0]??null) : (Math.floor(curServeTurn/2)%2===0 ? curServerPlayers[0] : curServerPlayers[1]);
  const serverLabel = curServerIndividual ?? (curServer==="A" ? match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/") : match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/"));
  const teamALabel = match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
  const teamBLabel = match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
  // 若番=自チーム左、遅番=自チーム右
  const isYounger = match.is_younger !== false;
  // left=左側表示チーム、right=右側表示チーム
  const leftTeam  = isYounger ? "A" : "B";
  const rightTeam = isYounger ? "B" : "A";
  const leftLabel  = isYounger ? teamALabel : teamBLabel;
  const rightLabel = isYounger ? teamBLabel : teamALabel;
  const aClub = match.players.find(p=>p.team==="A")?.club_name??"";
  const bClub = match.players.find(p=>p.team==="B")?.club_name??"";
  const leftClub   = isYounger ? aClub : bClub;
  const rightClub  = isYounger ? bClub : aClub;
  const leftScore  = (g) => isYounger ? g.score_a : g.score_b;
  const rightScore = (g) => isYounger ? g.score_b : g.score_a;
  const leftMatchScore  = isYounger ? match.match_score_a : match.match_score_b;
  const rightMatchScore = isYounger ? match.match_score_b : match.match_score_a;

  function resetSel(){ setSelPlay(null); setSelSide(null); setSelResult(null); setSelPlayer(null); setSelPlayerId(null); setScoreStep(1); setPendingTeam(null); }

  const startingGameRef = useRef(false); // ★第1ゲーム開始の二重呼び出し防止（duplicate keyエラー対策）
  function startNewGame(base=match, overrideServer=null){
    if (startingGameRef.current) return; // 連打・多重タップは無視
    const server = overrideServer || base.first_server;
    if (!server) {
      setServeSelectModal(true);
      return;
    }
    startingGameRef.current = true;
    // ★予定(scheduled)・待機中(waiting)のまま作成された試合（ドロー経由など）が、採点開始後も
    //   ずっとその表示のままにならないよう、ここで進行中(active)に切り替える
    const statusFix = (base.status === "scheduled" || base.status === "waiting") ? { status: "active" } : {};
    base = { ...base, ...statusFix, first_server: server };
    const num=base.games.length+1;
    const isFin=isFinalGame(base.game_format,base.match_score_a,base.match_score_b);
    const srv=gameServer(base.first_server||server,num);
    const g={id:uid(),match_id:base.id,game_number:num,server_team:srv,is_final:isFin,score_a:0,score_b:0,winner_team:null,points:[],faults:[]};
    persist({...base,games:[...base.games,g]});
    setTimeout(()=>{ startingGameRef.current = false; }, 800); // 保存が実行された後にロック解除
  }

  function addPoint(team, resultKey=selResult, playerName=selPlayer){
    if(!currentGame) return;
    const cg=currentGame;
    const newA=team==="A"?cg.score_a+1:cg.score_a;
    const newB=team==="B"?cg.score_b+1:cg.score_b;
    const isWin = resultKey ? isWinnerResult(resultKey) : null;
    const pt={
      id:uid(),game_id:cg.id,match_id:match.id,
      point_number:nonFaultPts.length+1,
      scoring_team:team,
      player_name:playerName??null,
      play_type:selPlay??null,
      side_type:selSide??null,
      result_type:resultKey??null,
      is_winner:isWin,
      fault_count:fault, // ★このポイントの前に何回フォルトがあったか（0=1stイン、1=2ndイン、2=ダブルフォルト）
      score_a_after:newA, score_b_after:newB,
      scored_at:new Date().toISOString(), // ★動画同期用：得点をタップした瞬間の時刻
    };
    const updG={...cg,points:[...cg.points,pt],score_a:newA,score_b:newB};
    const gWin=cg.is_final?checkFinalWinner(newA,newB):checkNormalWinner(newA,newB);
    if(gWin) updG.winner_team=gWin;
    const newMA=match.match_score_a+(gWin==="A"?1:0);
    const newMB=match.match_score_b+(gWin==="B"?1:0);
    const updM={...match,games:match.games.map(g=>g.id===cg.id?updG:g),match_score_a:newMA,match_score_b:newMB};
    resetSel(); setFault(0);
    if(gWin){
      if(newMA>=winGames||newMB>=winGames){ persist(updM); setModal({type:"matchOver",winner:gWin,gameId:cg.id,sA:newMA,sB:newMB}); }
      else { persist(updM); setModal({type:"gameOver",winner:gWin,num:cg.game_number,gameId:cg.id,sA:newMA,sB:newMB}); }
    } else { persist(updM); }
  }

  // ★ウィザードのステップ操作
  function wizardChooseTeam(team){
    setPendingTeam(team);
    setScoreStep(2);
  }
  function wizardChooseReason(resultKey){
    setSelResult(resultKey);
    setScoreStep(3);
  }
  function wizardBack(){
    if(scoreStep===3){ setSelResult(null); setScoreStep(2); }
    else if(scoreStep===2){ setPendingTeam(null); setScoreStep(1); }
  }
  function wizardChoosePlayer(name){
    addPoint(pendingTeam, selResult, name);
  }
  function wizardSkipPlayer(){
    addPoint(pendingTeam, selResult, null);
  }

  function handleFault(){
    if(!currentGame) return;
    if(fault===0){
      const cg=currentGame;
      const f={id:uid(),game_id:cg.id,match_id:match.id,fault_number:(cg.faults?.length??0)+1,server_team:curServer,player_name:curServerIndividual??null,score_a_at:cg.score_a,score_b_at:cg.score_b};
      persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:[...(cg.faults??[]),f]}:g)});
      setFault(1);
    } else {
      setFault(0);
      addPoint(curServer==="A"?"B":"A");
    }
  }

  function handleServeRadio(v){
    if(!currentGame) return;
    const cg=currentGame;
    if(v==="1st"){
      if(fault===0) return; // すでに1stの表示のまま：何もしない
      // 2nd/df から選び直した場合：この得点用に仮登録していたフォルトを取り消して1stに戻す
      const faults = cg.faults ?? [];
      const newFaults = faults.length>0 ? faults.slice(0,-1) : faults;
      persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:newFaults}:g)});
      setFault(0);
      return;
    }
    if(v==="2nd"){
      if(fault===1) return; // すでに2nd：何もしない
      if(fault===0){
        const f={id:uid(),game_id:cg.id,match_id:match.id,fault_number:(cg.faults?.length??0)+1,server_team:curServer,player_name:curServerIndividual??null,score_a_at:cg.score_a,score_b_at:cg.score_b};
        persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:[...(cg.faults??[]),f]}:g)});
      }
      // df(2)から2ndへ選び直す場合はフォルト登録は既にあるのでそのまま件数据え置き
      setFault(1);
      return;
    }
    if(v==="df"){
      if(fault===2) return; // すでにdf：何もしない
      if(fault===0){
        const f={id:uid(),game_id:cg.id,match_id:match.id,fault_number:(cg.faults?.length??0)+1,server_team:curServer,player_name:curServerIndividual??null,score_a_at:cg.score_a,score_b_at:cg.score_b};
        persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:[...(cg.faults??[]),f]}:g)});
      }
      // dfはここでは即座に得点を入れず、「レシーブ側の得点ボタン」を押して初めて確定する状態にする
      setFault(2);
    }
  }

  // ★得点ボタンを先に押す流れ用：指定したゲームの最後のポイントの詳細を後から書き換える（試合中・ゲーム終了直後どちらでも使える汎用版）
  function updatePointDetail(gameId, field, value){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g || g.points.length===0) return;
    const idx = g.points.length-1;
    const lastPt = g.points[idx];
    const newVal = lastPt[field]===value ? null : value; // 同じチップをもう一度押したら解除
    const updatedPt = {...lastPt, [field]:newVal};
    if(field==="result_type"){
      updatedPt.is_winner = newVal ? isWinnerResult(newVal) : null;
    }
    const newPoints = g.points.map((p,i)=> i===idx ? updatedPt : p);
    persist({...match, games: match.games.map(gm=>gm.id===gameId?{...g,points:newPoints}:gm)});
  }
  function updateLastPoint(field, value){
    if(!currentGame) return;
    updatePointDetail(currentGame.id, field, value);
  }
  // ★ゲーム終了直後の「最後の1点」に詳細を追記するための共通UIブロック
  function renderPointDetailEditor(gameId){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g || g.points.length===0) return null;
    const lp = g.points[g.points.length-1];
    const detailParts=[lp.player_name,lp.play_type&&getPlayLabel(lp.play_type),lp.result_type&&getResultLabel(lp.result_type),lp.side_type&&getSideLabel(lp.side_type)].filter(Boolean);
    return (
      <div style={{ textAlign:"left",marginTop:14,paddingTop:14,borderTop:`1px solid ${C.border}` }}>
        <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:4 }}>最後の1点の詳細を追加（任意）</div>
        <div style={{ fontSize:10,color:"#5b8bc9",marginBottom:8 }}>{detailParts.length>0?detailParts.join("・"):"選手・結果・プレイ内容は未選択"}</div>
        <div style={{ marginBottom:8 }}>
          {allPlayers.map(p=>{ const isSel=lp.player_name===p.name; return <span key={p.id} style={S.chip(isSel)} onClick={()=>updatePointDetail(gameId,"player_name",p.name)}>{p.name}</span>; })}
        </div>
        <div style={{ marginBottom:8 }}>
          {RESULT_TYPES.map(r=>{ const isSel=lp.result_type===r.key; return <span key={r.key} style={S.chip(isSel)} onClick={()=>updatePointDetail(gameId,"result_type",r.key)}>{r.label}</span>; })}
        </div>
        <div style={{ marginBottom:8 }}>
          {PLAY_TYPES.map(p=>{ const isSel=lp.play_type===p.key; return <span key={p.key} style={S.chip(isSel)} onClick={()=>updatePointDetail(gameId,"play_type",p.key)}>{p.label}</span>; })}
        </div>
        <div>
          {SIDE_TYPES.map(s=>{ const isSel=lp.side_type===s.key; return <span key={s.key} style={S.chip(isSel)} onClick={()=>updatePointDetail(gameId,"side_type",s.key)}>{s.label}</span>; })}
        </div>
      </div>
    );
  }

  function undo(){
    if(!currentGame||currentGame.points.length===0) return;
    const cg=currentGame;
    const newPts=cg.points.slice(0,-1);
    const last=newPts[newPts.length-1];
    const updG={...cg,points:newPts,score_a:last?.score_a_after??0,score_b:last?.score_b_after??0,winner_team:null};
    persist({...match,games:match.games.map(g=>g.id===cg.id?updG:g)});
    setFault(0);
  }

  // ★試合終了後、過去の任意のゲームのポイント構成が変わった際にスコア・勝敗を再計算して保存する共通処理
  function applyGamePointsChange(gameId, newPoints){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    let a=0, b=0;
    const recalced = newPoints.map((p,i)=>{
      if(p.scoring_team==="A") a++; else b++;
      return {...p, point_number:i+1, score_a_after:a, score_b_after:b};
    });
    const finalA = recalced.length ? recalced[recalced.length-1].score_a_after : 0;
    const finalB = recalced.length ? recalced[recalced.length-1].score_b_after : 0;
    const newWinner = g.is_final ? checkFinalWinner(finalA,finalB) : checkNormalWinner(finalA,finalB);
    const updG = {...g, points:recalced, score_a:finalA, score_b:finalB, winner_team:newWinner};
    const newGames = match.games.map(gm=>gm.id===gameId?updG:gm);
    const newScoreA = newGames.filter(gm=>gm.winner_team==="A").length;
    const newScoreB = newGames.filter(gm=>gm.winner_team==="B").length;
    persist({...match, games:newGames, match_score_a:newScoreA, match_score_b:newScoreB});
  }

  function deletePointFromGame(gameId, pointId){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    applyGamePointsChange(gameId, g.points.filter(p=>p.id!==pointId));
  }

  function updatePointInGame(gameId, pointId, updates){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    applyGamePointsChange(gameId, g.points.map(p=>p.id===pointId?{...p,...updates}:p));
  }

  // ★試合終了後、過去の任意のゲームの好きな位置にポイントを挿入する
  function insertPointInGame(gameId, atIndex, values){
    const g = match.games.find(gm=>gm.id===gameId);
    if(!g) return;
    const newPoint = { id:uid(), game_id:gameId, match_id:match.id, ...values };
    const newPoints = [...g.points.slice(0,atIndex), newPoint, ...g.points.slice(atIndex)];
    applyGamePointsChange(gameId, newPoints);
  }

  const allPlayers = match.players.map(p=>({ id:p.id, name:p.player_name, team:p.team }));

  const [navigatingBack, setNavigatingBack] = useState(false);
  async function handleBack() {
    setNavigatingBack(true);
    try {
      await saveQueueRef.current;
    } catch(e) {
      // 保存失敗はpersist側でalert済み
    }
    onBack();
  }

  return (
    <div style={S.page}>
      {/* スコアボードヘッダー */}
      <div style={{ background:`linear-gradient(135deg,${C.navy},${C.navyMid})`, padding:"10px 14px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer", opacity:navigatingBack?0.5:1, flex:"none" }} disabled={navigatingBack} onClick={handleBack}>{navigatingBack?"…":"←"}</button>
          <div style={{ textAlign:"center", flex:1, minWidth:0, padding:"0 6px" }}>
            {match.tournament_name&&<div style={{ fontSize:11,color:"rgba(255,255,255,0.8)",fontWeight:700,overflowWrap:"break-word" }}>{match.tournament_name}{match.round?` · ${match.round}`:""}</div>}
            <div style={{ fontSize:10,color:"rgba(255,255,255,0.5)" }}>{fmtDate(match.match_date)}{match.venue?` · ${match.venue}`:""}{match.court_number?` · ${match.court_number}`:""} · {match.game_format}Gマッチ</div>
          </div>
          <div style={{ display:"flex", gap:6, flex:"none" }}>
            {match.status==="active" && (
              <button
                style={{ background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,color:C.white,fontSize:13,padding:"5px 8px",cursor:"pointer", opacity: refreshing ? 0.5 : 1 }}
                onClick={onRefresh}
                disabled={refreshing}
                title="最新データに更新"
              >{refreshing ? "..." : "🔄"}</button>
            )}
            <button style={{ background:"rgba(255,255,255,0.15)",border:"none",borderRadius:8,color:C.white,fontSize:13,padding:"5px 8px",cursor:"pointer" }} onClick={()=>onEdit&&onEdit(match.id)} title="試合情報を編集">✏️</button>
          </div>
        </div>

        {/* スコアボード: 行ごとgridで左右高さを統一 */}
        <div style={{ background:"rgba(0,0,0,0.25)",borderRadius:14,padding:"10px 8px" }}>
          {/* サーブ行（固定高さ16px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:2 }}>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center" }}>
              {curServer===leftTeam && <span style={{ fontSize:9,color:C.serve,fontWeight:700 }}>&#127934; サーブ</span>}
            </div>
            <div/>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center" }}>
              {curServer===rightTeam && <span style={{ fontSize:9,color:C.serve,fontWeight:700 }}>&#127934; サーブ</span>}
            </div>
          </div>
          {/* チーム名行（固定高さ16px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:2 }}>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden" }}>
              <span style={{ fontSize:10,color:"rgba(255,255,255,0.6)",whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden" }}>{leftClub}</span>
            </div>
            <div/>
            <div style={{ textAlign:"center",height:16,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden" }}>
              <span style={{ fontSize:10,color:"rgba(255,255,255,0.6)",whiteSpace:"nowrap",textOverflow:"ellipsis",overflow:"hidden" }}>{rightClub}</span>
            </div>
          </div>
          {/* 選手名行（固定高さ20px） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,marginBottom:6 }}>
            <div style={{ textAlign:"center",minHeight:20,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <span style={{ fontSize:11,fontWeight:700,color:C.white,lineHeight:1.3 }}>{leftLabel}</span>
            </div>
            <div/>
            <div style={{ textAlign:"center",minHeight:20,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <span style={{ fontSize:11,fontWeight:700,color:C.white,lineHeight:1.3 }}>{rightLabel}</span>
            </div>
          </div>
          {/* 左右=ゲーム内ポイント（大きく）、中央=ゲームカウント（小さく） */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 88px 1fr",gap:8,alignItems:"center" }}>
            {/* 左 */}
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:56,fontWeight:900,color:C.white,lineHeight:1 }}>
                {currentGame ? leftScore(currentGame) : "—"}
              </div>
            </div>
            {/* 中央：ゲームカウント */}
            <div style={{ textAlign:"center" }}>
              <div style={{ background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"6px 4px" }}>
                <div style={{ fontSize:9,color:"rgba(255,255,255,0.6)",marginBottom:3 }}>
                  {currentGame ? ("G" + currentGame.game_number + (currentGame.is_final ? " F" : "")) : ""}
                </div>
                <div style={{ display:"flex",gap:3,alignItems:"center",justifyContent:"center" }}>
                  <span style={{ fontSize:18,fontWeight:900,color:leftMatchScore>=winGames?"#fbbf24":C.white }}>{leftMatchScore}</span>
                  <span style={{ color:"rgba(255,255,255,0.4)",fontSize:11 }}>-</span>
                  <span style={{ fontSize:18,fontWeight:900,color:rightMatchScore>=winGames?"#fbbf24":C.white }}>{rightMatchScore}</span>
                </div>
                {fault===1 && <div style={{ fontSize:9,color:C.serve,marginTop:2,fontWeight:700 }}>1st F</div>}
              </div>
            </div>
            {/* 右 */}
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:56,fontWeight:900,color:C.white,lineHeight:1 }}>
                {currentGame ? rightScore(currentGame) : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* ゲームバッジ */}
        <div style={{ display:"flex",gap:5,marginTop:8,flexWrap:"wrap",justifyContent:"center" }}>
          {match.games.map(g=>(
            <div key={g.id} style={{ padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:g.winner_team===leftTeam?(isYounger?"#2ecc71":"#f97316"):g.winner_team===rightTeam?(isYounger?"#f97316":"#2ecc71"):"rgba(255,255,255,0.2)",color:C.white }}>
              {g.is_final?"🔥":""}G{g.game_number}: {leftScore(g)}-{rightScore(g)}
            </div>
          ))}
        </div>
        {currentGameIsFinal&&currentGame&&<div style={{ textAlign:"center",marginTop:6 }}><span style={{ fontSize:10,fontWeight:800,color:C.white,background:"#dc2626",padding:"2px 10px",borderRadius:20 }}>🔥 ファイナルゲーム（7点先取）</span></div>}
      </div>

      {/* タブ */}
      {viewOnly && (
        <div style={{ background:"#f5f5f5", borderBottom:"1px solid #e0e0e0", padding:"8px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, color:C.textSec, fontWeight:700 }}>👁 観戦モード（スコア閲覧のみ）</span>
            <button
              style={{ background:C.navy, border:"none", borderRadius:8, color:"#fff", fontSize:12, padding:"5px 10px", cursor:"pointer", opacity: refreshing ? 0.5 : 1 }}
              onClick={onRefresh} disabled={refreshing}
            >{refreshing ? "更新中..." : "🔄 最新に更新"}</button>
          </div>
          {/* ★試合が終了していなければ、いつでも自分が記録者としてロックを引き継げるようにする
                （記録者ロックが自分以外・または不整合になっていても、これで即座に復帰できる） */}
          {match.status!=="finished" && (
            <button
              style={{ ...S.btn(C.navy), fontSize:12, padding:"9px", marginTop:8 }}
              onClick={async ()=>{
                try {
                  const { data:{ user } } = await supabase.auth.getUser();
                  const profile = await getMyProfile();
                  if (teamMatchId) {
                    const { data: tmg } = await supabase.from("team_match_games").select("id").eq("match_id", match.id).maybeSingle();
                    if (tmg) await updateTeamMatchGame(tmg.id, { recorder_id:user.id, recorder_name: profile?.name || null });
                  } else {
                    await supabase.from("matches").update({ created_by:user.id }).eq("id", match.id);
                  }
                  onReload();
                } catch(e) {
                  alert("エラー: " + (e.message || e));
                }
              }}
            >🔓 自分が記録者になる（続きから記録する）</button>
          )}
          {/* ★「結果だけ記録」で終えた試合（ゲームが1つも無いまま終了扱い）は、
                ここから直接ポイント記録に切り替えられるようにする */}
          {match.status==="finished" && match.games.length===0 && (
            <button
              style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:12, padding:"9px", marginTop:8 }}
              onClick={async ()=>{
                const msg = "スコアをリセットして、ここからポイントを記録し直しますか？";
                if (!window.confirm(msg)) return;
                try {
                  const { data:{ user } } = await supabase.auth.getUser();
                  const profile = await getMyProfile();
                  await resetMatchToUnrecorded(match.id);
                  if (teamMatchId) {
                    const { data: tmg } = await supabase.from("team_match_games").select("id").eq("match_id", match.id).maybeSingle();
                    if (tmg) await updateTeamMatchGame(tmg.id, { status:"waiting", recorder_id:user.id, recorder_name: profile?.name || null });
                  } else {
                    await supabase.from("matches").update({ created_by:user.id }).eq("id", match.id);
                  }
                  onReload();
                } catch(e) {
                  alert("エラー: " + (e.message || e));
                }
              }}
            >🎾 ここからポイントを記録し直す</button>
          )}
        </div>
      )}
      <div style={{ display:"flex",background:C.white,borderBottom:`1px solid ${C.border}` }}>
        {[["record","記録"],["score","スコア"],["stats","スタッツ"]].map(([v,l])=>(
          <button key={v} style={{ flex:1,padding:11,border:"none",cursor:"pointer",background:"transparent",fontWeight:tab===v?700:400,fontSize:14,color:tab===v?C.accent:C.textSec,borderBottom:tab===v?`3px solid ${C.accent}`:"3px solid transparent" }} onClick={()=>setTab(v)}>{l}</button>
        ))}
      </div>

      {/* 記録タブ */}
      {tab==="record"&&(
        <div style={{ padding:"10px 12px 20px" }}>
          {match.games.length>0 && !viewOnly && (
            <div style={{ textAlign:"right", marginBottom:8 }}>
              <button
                style={{ border:"1px solid "+C.border, background:C.gray, borderRadius:8, fontSize:11, color:C.textSec, cursor:"pointer", padding:"5px 10px", fontWeight:700 }}
                onClick={()=>setResetConfirm(true)}
              >🗑️ スコア全削除</button>
            </div>
          )}
          {match.games.length===0&&match.status!=="finished"&&(
            <div style={{ textAlign:"center",padding:"40px 0" }}>
              <div style={{ fontSize:36,marginBottom:12 }}>🎾</div>
              <p style={{ color:C.textSec,marginBottom:8 }}>第1ゲームを開始してください</p>
              {match.first_server ? (
                <>
                  <p style={{ fontSize:13,color:match.first_server==="A"?C.teamA:C.teamB,fontWeight:700,marginBottom:8 }}>最初のサーブ: {match.first_server==="A"?teamALabel:teamBLabel}</p>
                  <button
                    style={{ border:"1px solid "+C.border, background:C.gray, borderRadius:8, fontSize:11, color:C.textSec, cursor:"pointer", padding:"5px 10px", fontWeight:700, marginBottom:20 }}
                    onClick={()=>persist({ ...match, first_server: match.first_server==="A" ? "B" : "A" })}
                  >🔄 サーブを入れ替える</button>
                </>
              ) : (
                <p style={{ fontSize:13,color:C.textSec,marginBottom:20 }}>最初のサーブは次の画面で選択します</p>
              )}
              <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>startNewGame()}>第1ゲーム開始</button>
              {match.status==="scheduled" && (
                <button
                  style={{ ...S.btn(`linear-gradient(135deg,#7b1fa2,${C.purple})`), marginTop:10 }}
                  onClick={()=>persist({ ...match, status:"waiting" })}
                >⏳ 待機中にする</button>
              )}
              {match.status==="waiting" && (
                <div style={{ marginTop:10, fontSize:12, color:C.purple, fontWeight:700, background:"#eef0fe", display:"inline-block", padding:"4px 14px", borderRadius:20 }}>⏳ 待機中</div>
              )}
            </div>
          )}
          {!currentGame&&match.games.length>0&&match.status!=="finished"&&(
            <div style={{ textAlign:"center",padding:"30px 0" }}>
              <p style={{ color:C.textSec,marginBottom:16 }}>ゲーム終了。次のゲームへ</p>
              <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>startNewGame()}>第{match.games.length+1}ゲーム開始</button>
            </div>
          )}
          {match.status==="finished"&&!correctMode&&(
            <div>
              {/* 結果サマリー */}
              <div style={{ textAlign:"center",padding:"24px 0 16px" }}>
                <div style={{ fontSize:52 }}>🏆</div>
                <p style={{ fontSize:18,fontWeight:800,color:C.accent,marginTop:8 }}>試合終了</p>
                <p style={{ fontSize:14,fontWeight:700,color:C.white,marginTop:4,background:C.navy,display:"inline-block",padding:"4px 16px",borderRadius:20 }}>
                  {match.match_score_a>match.match_score_b?teamALabel:teamBLabel} の勝利！
                </p>
              </div>
              {/* ゲーム別スコア一覧（両チームの選手名を表示） */}
              <div style={{ background:C.white,borderRadius:12,border:"1px solid "+C.border,overflow:"hidden",marginBottom:12 }}>
                <div style={{ background:C.navy,padding:"8px 14px",display:"flex",alignItems:"center" }}>
                  <span style={{ flex:1,fontSize:11,fontWeight:700,color:C.white }}>ゲーム別スコア</span>
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:isYounger?"#2ecc71":"#f97316",textAlign:"center" }}>{leftLabel}</span>
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:isYounger?"#f97316":"#2ecc71",textAlign:"center" }}>{rightLabel}</span>
                </div>
                {match.games.map(g=>(
                  <div key={g.id} style={{ display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:"1px solid "+C.border }}>
                    <span style={{ fontSize:12,color:C.textSec,width:46 }}>{g.is_final?"🔥":""}G{g.game_number}</span>
                    <span style={{ flex:1,fontSize:15,fontWeight:700,textAlign:"center" }}>
                      <span style={{ color:g.winner_team===leftTeam?(isYounger?"#2ecc71":"#f97316"):C.textSec }}>{leftScore(g)}</span>
                      <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                      <span style={{ color:g.winner_team===rightTeam?(isYounger?"#f97316":"#2ecc71"):C.textSec }}>{rightScore(g)}</span>
                    </span>
                    <span style={{ width:74,textAlign:"center" }}>{g.winner_team===leftTeam?<span style={{ display:"inline-block",width:13,height:13,borderRadius:"50%",background:"#d4e157",border:"1px solid #aeb92a" }}/>:""}</span>
                    <span style={{ width:74,textAlign:"center" }}>{g.winner_team===rightTeam?<span style={{ display:"inline-block",width:13,height:13,borderRadius:"50%",background:"#d4e157",border:"1px solid #aeb92a" }}/>:""}</span>
                  </div>
                ))}
                <div style={{ display:"flex",alignItems:"center",padding:"12px 14px",background:C.accentL }}>
                  <span style={{ fontSize:12,fontWeight:700,color:C.navy,width:46 }}>合計</span>
                  <span style={{ flex:1,fontSize:20,fontWeight:900,textAlign:"center" }}>
                    <span style={{ color:leftMatchScore>rightMatchScore?(isYounger?"#2ecc71":"#f97316"):C.textSec }}>{leftMatchScore}</span>
                    <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                    <span style={{ color:rightMatchScore>leftMatchScore?(isYounger?"#f97316":"#2ecc71"):C.textSec }}>{rightMatchScore}</span>
                  </span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{leftMatchScore>rightMatchScore?"🏆":""}</span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{rightMatchScore>leftMatchScore?"🏆":""}</span>
                </div>
              </div>
              {/* 試合メモ */}
              {!viewOnly && (
                <div style={{ ...S.card, padding:14, marginBottom:8 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:8 }}>📝 試合メモ</div>
                  <textarea
                    style={{ width:"100%",minHeight:70,border:`1px solid ${C.border}`,borderRadius:8,padding:10,fontSize:13,fontFamily:"inherit",resize:"vertical" }}
                    placeholder="気づいたこと、課題、次への作戦などを自由にメモできます"
                    value={memoDraft}
                    onChange={e=>{ setMemoDraft(e.target.value); setMemoSaved(false); }}
                  />
                  <button
                    style={{ ...S.btn(memoSaved?"#f0f0f0":C.navy), color:memoSaved?C.textSec:C.white, fontSize:12, marginTop:8, padding:"9px" }}
                    disabled={memoSaved}
                    onClick={()=>{ persist({...match, memo: memoDraft}); setMemoSaved(true); }}
                  >{memoSaved ? "保存済み" : "💾 メモを保存"}</button>
                </div>
              )}
              {/* ボタン群 */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8 }}>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("stats")}>📊 スタッツを見る</button>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("score")}>📋 スコアを見る</button>
              </div>
              {!viewOnly && (
                <>
                  <button style={{ ...S.btn("#fff"),color:C.navy,border:"1px solid "+C.border,marginBottom:8 }} onClick={()=>onEdit&&onEdit(match.id)}>✏️ 試合情報を編集</button>
                  <button style={{ ...S.btn("#fff"),color:C.orange,border:"1px solid "+C.orange,marginBottom:8 }} onClick={()=>setCorrectMode(true)}>✏️ スコアを修正</button>
                  <button style={{ ...S.btn("#fff"),color:C.textSec,border:"1px solid "+C.border,marginBottom:8,fontSize:12 }} onClick={()=>{ if(window.confirm("この試合を「途中終了」扱いに変更しますか？\nスコアはそのまま残りますが、勝敗の集計から除外されます。")) persist({ ...match, status:"abandoned" }); }}>実は途中終了だった試合として、勝敗集計から除外する</button>
                  <button style={{ ...S.btn("#06c755"),marginBottom:8 }} onClick={()=>window.open("https://line.me/R/msg/text/?"+encodeURIComponent(buildLineText(match)),"_blank")}>💬 LINEで結果を共有</button>
                </>
              )}
              <button style={{ ...S.btn("linear-gradient(135deg,"+C.accent+",#00a066)") }} onClick={handleBack}>← 試合一覧に戻る</button>
            </div>
          )}

          {match.status==="finished"&&correctMode&&!viewOnly&&(
            <div>
              <div style={{ background:"#fff3e0",border:"1px solid #ffd699",borderRadius:10,padding:"10px 12px",marginBottom:12,fontSize:12,color:"#7a5800" }}>
                ✏️ 修正したいポイントをタップすると内容の変更・削除ができます。「＋」では好きな位置にポイントを追加できます。
              </div>
              {match.games.map(g=>(
                <div key={g.id} style={S.card}>
                  <div style={{ padding:"8px 12px",background:C.navyMid,color:C.white,display:"flex",justifyContent:"space-between" }}>
                    <span style={{ fontWeight:700,fontSize:13 }}>{g.is_final?"🔥":""}第{g.game_number}ゲーム</span>
                    <span style={{ fontWeight:700 }}>{g.score_a} - {g.score_b}</span>
                  </div>
                  <div style={{ padding:"8px 10px" }}>
                    <div style={{ textAlign:"center" }}>
                      <button style={{ background:"none",border:`1px dashed ${C.border}`,borderRadius:8,color:C.accent,fontSize:11,fontWeight:700,cursor:"pointer",padding:"4px 10px",width:"100%" }} onClick={()=>setAddingPoint({gameId:g.id,atIndex:0})}>＋ 先頭に追加</button>
                    </div>
                    {g.points.length===0&&<div style={{ fontSize:12,color:C.textSec,padding:"10px 4px",textAlign:"center" }}>記録なし</div>}
                    {g.points.map((pt,idx)=>(
                      <div key={pt.id}>
                        <div style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:C.gray,borderRadius:8,marginTop:4,borderLeft:`4px solid ${pt.scoring_team==="A"?C.accent:C.orange}`,cursor:"pointer" }} onClick={()=>setEditingPoint({gameId:g.id,point:pt})}>
                          <span style={{ fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20,background:pt.scoring_team==="A"?C.accentL:C.redL,color:pt.scoring_team==="A"?C.accent:C.red,whiteSpace:"nowrap" }}>
                            {pt.scoring_team==="A"?"A 得点":"B 得点"}
                          </span>
                          <span style={{ fontSize:11,flex:1,color:C.text }}>
                            {[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):null,pt.side_type?getSideLabel(pt.side_type):null,pt.result_type?getResultLabel(pt.result_type):null].filter(Boolean).join(" · ")||"—"}
                          </span>
                          <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{pt.score_a_after}-{pt.score_b_after}</span>
                          <span style={{ fontSize:14,color:C.textSec,flexShrink:0 }}>›</span>
                        </div>
                        <div style={{ textAlign:"center",marginTop:4 }}>
                          <button style={{ background:"none",border:"none",color:C.accent,fontSize:10,fontWeight:700,cursor:"pointer",padding:"3px 8px" }} onClick={()=>setAddingPoint({gameId:g.id,atIndex:idx+1})}>＋ ここに追加</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`),marginTop:4 }} onClick={()=>setCorrectMode(false)}>修正を完了</button>
            </div>
          )}

          {editingPoint && (
            <PointEditModal
              mode="edit"
              point={editingPoint.point}
              players={allPlayers}
              teamALabel={teamALabel}
              teamBLabel={teamBLabel}
              onClose={()=>setEditingPoint(null)}
              onSave={(updates)=>{ updatePointInGame(editingPoint.gameId, editingPoint.point.id, updates); setEditingPoint(null); }}
              onDelete={()=>{ if(window.confirm("このポイントを削除しますか？削除後はスコアが自動的に再計算されます。")){ deletePointFromGame(editingPoint.gameId, editingPoint.point.id); setEditingPoint(null); } }}
            />
          )}

          {addingPoint && (
            <PointEditModal
              mode="add"
              point={{ scoring_team:"A", play_type:null, side_type:null, result_type:null, player_name:null }}
              players={allPlayers}
              teamALabel={teamALabel}
              teamBLabel={teamBLabel}
              onClose={()=>setAddingPoint(null)}
              onSave={(values)=>{ insertPointInGame(addingPoint.gameId, addingPoint.atIndex, values); setAddingPoint(null); }}
            />
          )}

          {currentGame&&match.status!=="finished"&&(
            <>
              {/* サーブ表示：大型セグメントボタン（1st=緑／2nd=黄／df=赤、案①の配色＋案②サイズ） */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",marginBottom:10 }}>
                <div style={{ fontSize:13,fontWeight:800,color:"#c9740b",display:"flex",alignItems:"center",gap:6,marginBottom:4 }}>🎾 {serverLabel}</div>
                <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>サービス</div>
                <div style={{ display:"flex",gap:8 }}>
                  {[{v:"1st",on:fault===0,color:"#2ecc71"},{v:"2nd",on:fault===1,color:"#f5a623"},{v:"df",on:fault===2,color:"#e74c3c"}].map(opt=>(
                    <div key={opt.v} onClick={()=>handleServeRadio(opt.v)} style={{
                      flex:1,textAlign:"center",padding:"10px 0",borderRadius:11,cursor:"pointer",userSelect:"none",
                      border:`2px solid ${opt.on?opt.color:C.border}`,
                      background:opt.on?opt.color:C.white,
                      transition:"all .15s ease",
                    }}>
                      <span style={{ fontSize:14,fontWeight:800,color:opt.on?C.white:"#a7adb8" }}>{opt.v==="df"?"DF":opt.v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* ★得点入力ウィザード（①どちらに1点→②決めた/相手ミス→③誰が、の3タップ） */}

              {/* 戻るリンク：常に同じ位置に表示し、ステップ1では隠す（②③でのみ表示） */}
              <div style={{ minHeight:26, marginBottom:4 }}>
                {scoreStep>1 && (
                  <button style={{ background:"none",border:"none",color:C.textSec,fontSize:13,fontWeight:700,padding:"4px 2px",cursor:"pointer" }} onClick={wizardBack}>← 戻る</button>
                )}
              </div>

              {scoreStep===1 && (
                <>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>①どちらに1点入りましたか？</div>
                  {fault===2&&<div style={{ fontSize:10,color:"#c0392b",textAlign:"center",marginBottom:8 }}>※ダブルフォルトのため、レシーブ側の得点ボタンを押してください</div>}
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                    {(()=>{
                      const leftIsServer = curServer===leftTeam;
                      const leftDisabled = fault===2 && leftIsServer;
                      const rightDisabled = fault===2 && !leftIsServer;
                      return (
                        <>
                          {/* 左ボタン：若番=自チーム(緑)、遅番=相手(赤) */}
                          <button disabled={leftDisabled} style={{ height:70,background:isYounger?"#2ecc71":"#f97316",color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:leftDisabled?"not-allowed":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(46,204,113,0.35)":"0 3px 10px rgba(249,115,22,0.35)",opacity:leftDisabled?0.35:1 }} onClick={()=>{ if(!leftDisabled){ if(fault===2){ addPoint(leftTeam);} else { wizardChooseTeam(leftTeam);} } }}>
                            <span style={{ fontSize:22,fontWeight:800 }}>+1</span>
                            <span style={{ fontSize:11,opacity:0.9 }}>{leftClub||"自チーム"}</span>
                          </button>
                          {/* 右ボタン：若番=相手(オレンジ)、遅番=自チーム(緑) */}
                          <button disabled={rightDisabled} style={{ height:70,background:isYounger?"#f97316":"#2ecc71",color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:rightDisabled?"not-allowed":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(249,115,22,0.35)":"0 3px 10px rgba(46,204,113,0.35)",opacity:rightDisabled?0.35:1 }} onClick={()=>{ if(!rightDisabled){ if(fault===2){ addPoint(rightTeam);} else { wizardChooseTeam(rightTeam);} } }}>
                            <span style={{ fontSize:22,fontWeight:800 }}>+1</span>
                            <span style={{ fontSize:11,opacity:0.9 }}>{rightClub||(isYounger?"相手":"自チーム")}</span>
                          </button>
                        </>
                      );
                    })()}
                  </div>
                  <button style={{ width:"100%",padding:11,background:"#f0f0f0",color:C.textSec,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:10 }} onClick={()=>setUndoConfirm(true)}>↩ 1点前に戻す</button>
                </>
              )}

              {scoreStep===2 && (
                <>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>②この1点は？</div>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                    <button style={{ height:60,background:C.white,border:"2px solid #2fa360",color:"#217a49",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer" }} onClick={()=>wizardChooseReason("winner")}>決めた</button>
                    <button style={{ height:60,background:C.white,border:"2px solid #c9506b",color:"#a63a53",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer" }} onClick={()=>wizardChooseReason("error")}>相手ミス</button>
                  </div>
                </>
              )}

              {scoreStep===3 && (()=>{
                const targetTeam = selResult==="winner" ? pendingTeam : (pendingTeam==="A"?"B":"A");
                const stepPlayers = allPlayers.filter(p=>p.team===targetTeam);
                return (
                  <>
                    <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>③{selResult==="winner"?"誰が決めた？":"誰のミス？"}</div>
                    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                      {stepPlayers.map(p=>(
                        <button key={p.id} style={{ minHeight:56,background:C.white,border:`2px solid ${C.border}`,color:C.text,borderRadius:14,fontSize:15,fontWeight:700,cursor:"pointer",padding:"10px 6px" }} onClick={()=>wizardChoosePlayer(p.name)}>{p.name}</button>
                      ))}
                    </div>
                    <button style={{ width:"100%",padding:11,background:"#f0f0f0",color:C.textSec,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:10 }} onClick={wizardSkipPlayer}>あとで入力（スキップ）</button>
                  </>
                );
              })()}

              {/* ★直前の記録の要約（どんなプレー？の対象を明示） */}
              {(()=>{
                const hasLast = nonFaultPts.length>0;
                if(!hasLast || scoreStep!==1) return null;
                const lp=nonFaultPts[nonFaultPts.length-1];
                const detailParts=[lp.player_name,lp.play_type&&getPlayLabel(lp.play_type),lp.result_type&&getResultLabel(lp.result_type),lp.side_type&&getSideLabel(lp.side_type)].filter(Boolean);
                return (
                  <details style={{ background:"#fff",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 12px",marginBottom:10 }}>
                    <summary style={{ fontSize:11,color:C.textSec,fontWeight:700,cursor:"pointer" }}>＋ どんなプレー？（任意）</summary>
                    <div style={{ marginTop:8,fontSize:10,color:"#5b8bc9" }}>対象：{detailParts.length>0?detailParts.join("・"):"（未選択）"}</div>
                    <div style={{ marginTop:8,marginBottom:4 }}>
                      {PLAY_TYPES.map(p=>{
                        const isSel = lp?.play_type===p.key;
                        return <span key={p.key} style={S.chip(isSel)} onClick={()=>updateLastPoint("play_type",p.key)}>{p.label}</span>;
                      })}
                    </div>
                    <div>
                      {SIDE_TYPES.map(s=>{
                        const isSel = lp?.side_type===s.key;
                        return <span key={s.key} style={S.chip(isSel)} onClick={()=>updateLastPoint("side_type",s.key)}>{s.label}</span>;
                      })}
                    </div>
                  </details>
                );
              })()}
              {teamMatchId && (
                <>
                  <button style={{ width:"100%",padding:11,background:"#fff3e0",color:"#b45309",border:"1px solid #fbbf24",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:8 }} onClick={()=>setSuspendConfirm(true)}>⏸ 中断</button>
                  <button style={{ width:"100%",padding:11,background:C.redL,color:C.red,border:"1px solid #f5b5b0",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:8 }} onClick={()=>setAbandonConfirm(true)}>⏹ 途中終了</button>
                </>
              )}

              {/* 直近記録（タップで編集・削除） */}
              {currentGame.points.length>0&&(
                <div style={{ marginTop:12 }}>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>記録した得点（タップで編集・削除）</div>
                  {[...currentGame.points].reverse().slice(0,5).map(pt=>(
                    <div key={pt.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.white,borderRadius:8,marginBottom:4,borderLeft:`4px solid ${pt.scoring_team==="A"?C.accent:C.orange}`,cursor:"pointer" }} onClick={()=>setEditingPoint({gameId:currentGame.id,point:pt})}>
                      <span style={{ fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20,background:pt.scoring_team==="A"?C.accentL:C.redL,color:pt.scoring_team==="A"?C.accent:C.red,whiteSpace:"nowrap" }}>
                        {pt.scoring_team==="A"?teamALabel||"A":teamBLabel||"B"}
                      </span>
                      <span style={{ fontSize:11,flex:1,color:C.text }}>
                        {[pt.player_name,pt.result_type?getResultLabel(pt.result_type):null,pt.play_type?getPlayLabel(pt.play_type):null,pt.side_type?getSideLabel(pt.side_type):null].filter(Boolean).join(" · ")||"—"}
                      </span>
                      <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{pt.score_a_after}-{pt.score_b_after}</span>
                      <span style={{ fontSize:13,color:C.textSec }}>›</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* スコアタブ */}
      {tab==="score"&&(
        <div style={{ padding:12 }}>
          {match.games.map(g=>(
            <div key={g.id} style={S.card}>
              <div style={{ padding:"8px 12px",background:g.winner_team==="A"?"#2ecc71":g.winner_team==="B"?"#f97316":C.accent,color:C.white,display:"flex",justifyContent:"space-between" }}>
                <span style={{ fontWeight:700,fontSize:13 }}>{g.is_final?"🔥":""}第{g.game_number}ゲーム</span>
                <span style={{ fontWeight:700 }}>{g.score_a} - {g.score_b}</span>
              </div>
              <div style={{ padding:"10px 12px" }}>
                <div style={{ display:"flex",gap:3,flexWrap:"wrap",marginBottom:8 }}>
                  {g.points.map(pt=>(
                    <div key={pt.id} title={[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):"",pt.side_type?getSideLabel(pt.side_type):"",pt.result_type?getResultLabel(pt.result_type):""].filter(Boolean).join(" ")} style={{ width:22,height:22,borderRadius:5,background:pt.scoring_team==="A"?"#2ecc71":"#f97316",display:"flex",alignItems:"center",justifyContent:"center",cursor:"default" }}>
                      <span style={{ fontSize:9,color:C.white,fontWeight:700 }}>{pt.scoring_team}</span>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ borderCollapse:"collapse",minWidth:280,fontSize:10 }}>
                    <tbody>
                      {[["A",teamALabel],["B",teamBLabel]].map(([team,name])=>(
                        <tr key={team}>
                          <td style={{ fontSize:10,color:team==="A"?C.teamA:C.teamB,fontWeight:700,paddingRight:8,whiteSpace:"nowrap" }}>
                            {g.server_team===team && <span style={{ display:"inline-block",width:8,height:8,borderRadius:"50%",background:C.red,marginRight:4,verticalAlign:"middle" }} title="サーブ側"/>}
                            {name}
                          </td>
                          {g.points.map((pt,i)=>(
                            <td key={i} style={{ padding:"2px 4px",textAlign:"center",background:pt.scoring_team===team?(pt.scoring_team==="A"?"#2ecc7118":"#f9731618"):"transparent",minWidth:28 }}>
                              {pt.scoring_team===team&&(
                                <div>
                                  <div style={{ fontSize:10,fontWeight:700,color:team==="A"?C.teamA:C.teamB }}>{pt.score_a_after}-{pt.score_b_after}</div>
                                  {pt.play_type&&<div style={{ fontSize:8,color:C.textSec }}>{getPlayLabel(pt.play_type).slice(0,4)}</div>}
                                </div>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {/* ★フォルト行：得点が記載されている列にだけ F / DF を表示 */}
                      <tr>
                        <td style={{ fontSize:10,color:C.textSec,fontWeight:700,paddingRight:8,whiteSpace:"nowrap" }}></td>
                        {g.points.map((pt,i)=>(
                          <td key={i} style={{ padding:"2px 4px",textAlign:"center",minWidth:28 }}>
                            {pt.fault_count===1&&<span style={{ fontSize:10,fontWeight:800,color:C.text }}>F</span>}
                            {pt.fault_count===2&&<span style={{ fontSize:10,fontWeight:800,color:C.text }}>DF</span>}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* スタッツタブ */}
      {tab==="stats"&&<StatsTab match={match} onDownloadCsv={()=>downloadCsv(match)} onShareLine={()=>window.open(`https://line.me/R/msg/text/?${encodeURIComponent(buildLineText(match))}`,"_blank")}/>}

      {modal?.type==="gameOver"&&(
        <Modal>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:44 }}>🎾</div>
            <h3 style={{ fontSize:18,fontWeight:800,margin:"8px 0" }}>第{modal.num}ゲーム終了！</h3>
            <p style={{ color:C.textSec }}>{modal.winner==="A"?teamALabel:teamBLabel} 勝利</p>
            <div style={{ fontSize:28,fontWeight:900,margin:"10px 0" }}><span style={{ color:isYounger?"#2ecc71":"#f97316" }}>{isYounger?modal.sA:modal.sB}</span><span style={{ color:C.textSec,margin:"0 8px" }}>-</span><span style={{ color:isYounger?"#f97316":"#2ecc71" }}>{isYounger?modal.sB:modal.sA}</span></div>
            {renderPointDetailEditor(modal.gameId)}
            <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`),marginTop:14 }} onClick={()=>{setModal(null);startNewGame();}}>次のゲームへ</button>
          </div>
        </Modal>
      )}

      {modal?.type==="matchOver"&&(
        <Modal>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:44 }}>🏆</div>
            <h3 style={{ fontSize:18,fontWeight:800,margin:"8px 0" }}>試合終了！</h3>
            <p style={{ color:C.textSec }}>{modal.winner==="A"?teamALabel:teamBLabel} 勝利</p>
            <div style={{ fontSize:28,fontWeight:900,margin:"10px 0" }}><span style={{ color:isYounger?"#2ecc71":"#f97316" }}>{isYounger?modal.sA:modal.sB}</span><span style={{ color:C.textSec,margin:"0 8px" }}>-</span><span style={{ color:isYounger?"#f97316":"#2ecc71" }}>{isYounger?modal.sB:modal.sA}</span></div>
            {renderPointDetailEditor(modal.gameId)}
            <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`),marginTop:14 }} onClick={()=>{ persist({...match,status:"finished"}); setModal(null); }}>結果を見る</button>
          </div>
        </Modal>
      )}

      {/* サーブ未設定時の選択モーダル */}
      {serveSelectModal && (
        <Modal onClose={()=>setServeSelectModal(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
            <h3 style={{ fontSize:16, fontWeight:800, margin:"8px 0 4px" }}>最初のサーブを選択</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:16 }}>どちらがサーブから始めますか？</p>
            <div style={{ display:"flex", gap:10, marginBottom:12 }}>
              {[["A", match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/") || "自チーム"],
                ["B", match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/") || "相手チーム"]
              ].map(([team, label]) => (
                <button key={team}
                  style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?"#2ecc71":"#f97316"}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?"#2ecc71":"#f97316" }}
                  onClick={async ()=>{
                    setServeSelectModal(false);
                    // DBのfirst_serverを更新してからゲーム開始
                    const updated = {...match, first_server: team};
                    await saveMatch(updated);
                    setMatch(updated);
                    startNewGame(updated, team);
                  }}
                >{label}<br/><span style={{ fontSize:11, fontWeight:400 }}>（サーブ）</span></button>
              ))}
            </div>
            <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:12 }} onClick={()=>setServeSelectModal(false)}>キャンセル</button>
          </div>
        </Modal>
      )}

      {undoConfirm && (
        <Modal onClose={()=>setUndoConfirm(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>↩️</div>
            <h3 style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>1点前に戻しますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:20 }}>直前に記録した1点が取り消されます。</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button style={{ padding:11, background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setUndoConfirm(false)}>キャンセル</button>
              <button style={{ padding:11, background:C.navy, color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>{ setUndoConfirm(false); undo(); }}>はい</button>
            </div>
          </div>
        </Modal>
      )}

      {resetConfirm && (
        <Modal onClose={()=>setResetConfirm(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>⚠️</div>
            <h3 style={{ fontSize:16, fontWeight:800, marginBottom:8, color:C.red }}>本当にスコアをリセットしますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:20 }}>記録したゲーム・ポイントがすべて削除され、未開始（0-0）の状態に戻ります。<b>この操作は元に戻せません。</b><br/>選手名・学校名・大会情報は残ります。</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button style={{ padding:11, background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setResetConfirm(false)}>キャンセル</button>
              <button
                style={{ padding:11, background:C.red, color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}
                onClick={async ()=>{
                  setResetConfirm(false);
                  // ★意図的な全削除はsaveMatch()の安全装置に阻まれないよう、
                  // 　ここで直接削除してから、リセット後の状態をDBに反映する
                  const updated = { ...match, games:[], match_score_a:0, match_score_b:0, status:"scheduled", first_server:null };
                  setMatch({...updated});
                  try {
                    const { data: existingGames } = await supabase.from("games").select("id").eq("match_id", match.id);
                    const gameIds = (existingGames ?? []).map(g => g.id);
                    if (gameIds.length) {
                      await supabase.from("points").delete().in("game_id", gameIds);
                      await supabase.from("faults").delete().in("game_id", gameIds);
                      await supabase.from("games").delete().in("id", gameIds);
                    }
                    await supabase.from("matches").update({
                      match_score_a:0, match_score_b:0, status:"scheduled", first_server:null,
                    }).eq("id", match.id);
                  } catch(e) { alert("リセットに失敗しました: "+(e.message||e)); }
                }}
              >リセットする</button>
            </div>
          </div>
        </Modal>
      )}

      {suspendConfirm && (
        <Modal onClose={()=>setSuspendConfirm(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>⏹️</div>
            <h3 style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>試合を中断しますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:20 }}>現在のスコアは保存されますが、勝敗の集計には含まれません。</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button style={{ padding:11, background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setSuspendConfirm(false)}>キャンセル</button>
              <button style={{ padding:11, background:"#b45309", color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={async ()=>{
                setSuspendConfirm(false);
                // ★「中断」は「終了(finished)」とは別の状態にし、勝敗・スタッツ集計から除外する
                const updated = { ...match, status:"suspended" };
                persist(updated);
                if (teamMatchId) {
                  try {
                    const { data: tmg } = await supabase.from("team_match_games").select("id").eq("match_id", match.id).maybeSingle();
                    if (tmg) await updateTeamMatchGame(tmg.id, { status:"suspended", recorder_id:null, recorder_name:null });
                  } catch(e) { /* 同期に失敗しても中断自体は継続 */ }
                }
                onBack();
              }}>中断する</button>
            </div>
          </div>
        </Modal>
      )}

      {abandonConfirm && (
        <Modal onClose={()=>setAbandonConfirm(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>⏹️</div>
            <h3 style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>この試合を「途中終了」にしますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:20 }}>現在のスコアはそのまま残ります（消えません）が、勝敗の集計には含まれません。<br/>ホーム画面の「記録途中の試合」には表示されなくなり、この試合は今後再開できなくなります。</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button style={{ padding:11, background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setAbandonConfirm(false)}>キャンセル</button>
              <button style={{ padding:11, background:C.red, color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={async ()=>{
                setAbandonConfirm(false);
                // ★「途中終了」は「中断」と同じく勝敗・スタッツ集計から除外するが、
                // 　ホーム画面の「記録途中の試合」には表示させず、再開もできない状態にする
                const updated = { ...match, status:"abandoned" };
                persist(updated);
                if (teamMatchId) {
                  try {
                    const { data: tmg } = await supabase.from("team_match_games").select("id").eq("match_id", match.id).maybeSingle();
                    if (tmg) await updateTeamMatchGame(tmg.id, { status:"suspended", recorder_id:null, recorder_name:null });
                  } catch(e) { /* 同期に失敗しても途中終了自体は継続 */ }
                }
                onBack();
              }}>途中終了</button>
            </div>
          </div>
        </Modal>
      )}

      <NavBar active="record" onNavigate={onNavigate}/>
    </div>
  );
}

// ============================================================
// スタッツタブ（★相手チームスタッツのバグ修正）
// ============================================================
// ============================================================
// ★試合サマリー／AI総評／改善優先順位／詳細分析パネル
// ============================================================
function MatchSummaryPanel({ match }) {
  const sum = calcMatchSummary(match);
  const highlights = buildHighlights(sum);
  const teamALabel = match.players.find(p=>p.team==="A")?.club_name || "自チーム";
  const teamBLabel = match.players.find(p=>p.team==="B")?.club_name || "相手チーム";
  const isFinished = match.status==="finished";
  const aWin = match.match_score_a > match.match_score_b;

  const detailBox = { background:C.white, border:`1px solid ${C.border}`, borderRadius:12, marginBottom:10, overflow:"hidden" };
  const summaryBtn = { fontSize:12, fontWeight:700, color:C.text, padding:"12px 14px", cursor:"pointer", listStyle:"none", display:"flex", alignItems:"center", gap:6 };

  function CompareRow({ label, a, b }) {
    return (
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 0", borderBottom:`1px solid ${C.border}`, fontSize:12 }}>
        <span style={{ fontWeight:700, color:C.teamA }}>{a}</span>
        <span style={{ color:C.textSec, fontSize:11 }}>{label}</span>
        <span style={{ fontWeight:700, color:C.teamB }}>{b}</span>
      </div>
    );
  }

  return (
    <div style={{ marginBottom:14 }}>
      {/* ①試合サマリー（試合結果／良かった点／改善ポイント／決定率・最多得点） */}
      <div style={{ ...detailBox, padding:14 }}>
        <div style={{ fontSize:13, fontWeight:800, marginBottom:12 }}>📋 試合サマリー</div>

        {isFinished && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10, background:C.gray, borderRadius:10, padding:14, marginBottom:14 }}>
            <span style={{ fontSize:13, fontWeight:800, padding:"4px 12px", borderRadius:20, color:C.white, background:aWin?C.accent:C.textSec }}>{aWin?"勝利":"敗北"}</span>
            <span style={{ fontSize:20, fontWeight:900, color:C.text }}>{match.match_score_a} - {match.match_score_b}</span>
          </div>
        )}

        {highlights.good.length>0 && (
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:800, color:C.accent, marginBottom:6, display:"flex", alignItems:"center", gap:5 }}>👍 良かった点</div>
            {highlights.good.map((t,i)=>(
              <div key={i} style={{ fontSize:12.5, color:C.text, lineHeight:1.5, padding:"8px 10px", background:C.gray, borderRadius:8, marginBottom:6 }}>{t}</div>
            ))}
          </div>
        )}

        {highlights.bad.length>0 && (
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:800, color:"#e08a2e", marginBottom:6, display:"flex", alignItems:"center", gap:5 }}>📝 改善ポイント</div>
            {highlights.bad.map((t,i)=>(
              <div key={i} style={{ fontSize:12.5, color:C.text, lineHeight:1.5, padding:"8px 10px", background:C.gray, borderRadius:8, marginBottom:6 }}>{t}</div>
            ))}
          </div>
        )}

        {(sum.decisionRate!=null || sum.topScorer) && (
          <div style={{ display:"flex", gap:10, marginTop:14 }}>
            {sum.decisionRate!=null && (
              <div style={{ flex:1, background:C.gray, borderRadius:10, padding:12, textAlign:"center" }}>
                <div style={{ fontSize:20, fontWeight:900, color:C.navy }}>{sum.decisionRate}%</div>
                <div style={{ fontSize:10.5, color:C.textSec, marginTop:2 }}>決定率</div>
              </div>
            )}
            {sum.topScorer && (
              <div style={{ flex:1, background:C.gray, borderRadius:10, padding:12, textAlign:"center" }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.navy }}>{sum.topScorer.player_name}</div>
                <div style={{ fontSize:10.5, color:C.textSec, marginTop:2 }}>最多得点（{sum.topScorer.winners}点）</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ②詳細分析（折りたたみ） */}
      <div style={{ fontSize:11, color:C.textSec, fontWeight:700, margin:"14px 2px 6px" }}>▼ 詳細分析</div>

      {(sum.posStats.front.name || sum.posStats.back.name) && (
        <details style={detailBox}>
          <summary style={summaryBtn}>📍 前衛・後衛分析</summary>
          <div style={{ padding:"0 14px 14px" }}>
            {["front","back"].map(key=>{
              const p = sum.posStats[key];
              if (!p.name) return null;
              const total = p.win+p.err;
              const rate = total>0 ? Math.round(p.win/total*100) : 0;
              return (
                <div key={key} style={{ marginBottom:8 }}>
                  <div style={{ fontSize:12, fontWeight:700, marginBottom:4 }}>{p.label}（{p.name}）</div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ flex:1, height:10, background:C.gray, borderRadius:5, overflow:"hidden" }}>
                      <div style={{ width:`${rate}%`, height:"100%", background:C.accent }}/>
                    </div>
                    <span style={{ fontSize:11, color:C.textSec, whiteSpace:"nowrap" }}>決定率{rate}%（決{p.win}／ミス{p.err}）</span>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {(sum.bestPlays.length>0 || sum.worstPlays.length>0) && (
        <details style={detailBox}>
          <summary style={summaryBtn}>🏸 プレー別ランキング</summary>
          <div style={{ padding:"0 14px 14px" }}>
            {sum.bestPlays.length>0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, color:C.textSec, fontWeight:700, marginBottom:6 }}>🏆 今日の武器</div>
                {sum.bestPlays.map((p,i)=>(
                  <div key={p.key} style={{ display:"flex", justifyContent:"space-between", fontSize:12, padding:"4px 0" }}>
                    <span>{["🥇","🥈","🥉"][i]} {p.label}</span>
                    <span style={{ fontWeight:700, color:C.accent }}>{p.rate}%（{p.win}/{p.total}）</span>
                  </div>
                ))}
              </div>
            )}
            {sum.worstPlays.length>0 && (
              <div>
                <div style={{ fontSize:11, color:C.textSec, fontWeight:700, marginBottom:6 }}>📉 改善ポイント</div>
                {sum.worstPlays.map((p,i)=>(
                  <div key={p.key} style={{ display:"flex", justifyContent:"space-between", fontSize:12, padding:"4px 0" }}>
                    <span>{i+1}. {p.label}</span>
                    <span style={{ fontWeight:700, color:C.red }}>{p.rate}%（{p.win}/{p.total}）</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}

      {sum.serveTotal>0 && (
        <details style={detailBox}>
          <summary style={summaryBtn}>🎾 サーブ分析</summary>
          <div style={{ padding:"0 14px 14px" }}>
            <CompareRow label="1stイン" a={`${sum.serve1st}本`} b={`${Math.round(sum.serve1st/sum.serveTotal*100)}%`} />
            <CompareRow label="2ndイン" a={`${sum.serve2nd}本`} b={`${Math.round(sum.serve2nd/sum.serveTotal*100)}%`} />
            <CompareRow label="ダブルフォルト" a={`${sum.serveDf}本`} b={`${Math.round(sum.serveDf/sum.serveTotal*100)}%`} />
            {sum.firstServeTotal>0 && (
              <div style={{ marginTop:10, fontSize:12 }}>1stサーブ時：得点{sum.firstServeWin} 失点{sum.firstServeTotal-sum.firstServeWin}（得点率{Math.round(sum.firstServeWin/sum.firstServeTotal*100)}%）</div>
            )}
            {sum.secondServeTotal>0 && (
              <div style={{ marginTop:4, fontSize:12 }}>2ndサーブ時：得点{sum.secondServeWin} 失点{sum.secondServeTotal-sum.secondServeWin}（得点率{Math.round(sum.secondServeWin/sum.secondServeTotal*100)}%）</div>
            )}
          </div>
        </details>
      )}

      <details style={detailBox}>
        <summary style={summaryBtn}>🔥 試合の流れ</summary>
        <div style={{ padding:"0 14px 14px" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div style={{ background:C.gray, borderRadius:8, padding:10 }}>
              <div style={{ fontSize:10, color:C.textSec, fontWeight:700 }}>最大連続得点</div>
              <div style={{ fontSize:16, fontWeight:800, color:C.accent }}>{sum.maxWinStreak}点</div>
            </div>
            <div style={{ background:C.gray, borderRadius:8, padding:10 }}>
              <div style={{ fontSize:10, color:C.textSec, fontWeight:700 }}>最大連続失点</div>
              <div style={{ fontSize:16, fontWeight:800, color:C.red }}>{sum.maxLoseStreak}点</div>
            </div>
          </div>
        </div>
      </details>

      {sum.timeline.length>0 && (
        <details style={detailBox}>
          <summary style={summaryBtn}>📈 得点推移（1ゲーム目）</summary>
          <div style={{ padding:"0 14px 14px" }}>
            {(() => {
              const PLAY_ICONS = { serve:"🎾", receive:"🖐", volley:"🖐", smash:"⚡", stroke:"🎾", attack:"⚡", shoot:"⚡", lob:"🖐", drop:"🖐" };
              return sum.timeline.map((p,i)=>{
                const isWin = p.team==="A";
                const icon = isWin ? (p.play ? (PLAY_ICONS[p.play]??"🎾") : "✅") : "❌";
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, padding:"4px 0" }}>
                    <span style={{ width:24, height:24, borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, background:isWin?"#e3f5ea":"#fbe6ea", flexShrink:0 }}>{icon}</span>
                    <span>{p.player ? `${p.player}${p.play?`（${getPlayLabel(p.play)}）`:""}` : (isWin?"相手ミス":"相手の攻撃/自分ミス")}</span>
                  </div>
                );
              });
            })()}
          </div>
        </details>
      )}
    </div>
  );
}

function StatsTab({ match, onDownloadCsv, onShareLine }) {
  const [teamFilter, setTeamFilter] = useState("A");
  const stats    = calcPlayerStats(match);
  const comments = calcAutoComment(stats, teamFilter);
  // ★修正: teamFilterで絞る（Bも正しく表示）
  const filtered = stats.filter(s => s.team === teamFilter);

  // ★チーム共通の目標値（自チーム＝Aのみに適用）
  const [goals, setGoals] = useState(null);
  useEffect(() => {
    (async () => {
      const profile = await getMyProfile();
      if (profile?.school_id) setGoals(await getSchoolGoals(profile.school_id));
    })();
  }, []);

  const allPts = match.games.flatMap(g => g.points);
  const totalA = allPts.filter(p=>p.scoring_team==="A").length;
  const totalB = allPts.filter(p=>p.scoring_team==="B").length;
  const winA   = allPts.filter(p=>p.scoring_team==="A"&&p.is_winner===true).length;
  const winB   = allPts.filter(p=>p.scoring_team==="B"&&p.is_winner===true).length;

  function Bar({ a, b, label }) {
    const max = Math.max(a, b, 1);
    const pctA = Math.round((a / max) * 100);
    const pctB = Math.round((b / max) * 100);
    return (
      <div style={{ marginBottom:12 }}>
        {/* 数値ラベル行 */}
        <div style={{ display:"flex", alignItems:"center", marginBottom:4 }}>
          <span style={{ fontSize:13, fontWeight:700, color:C.teamA, width:28, textAlign:"left" }}>{a}</span>
          <span style={{ flex:1, fontSize:11, color:C.textSec, textAlign:"center" }}>{label}</span>
          <span style={{ fontSize:13, fontWeight:700, color:C.teamB, width:28, textAlign:"right" }}>{b}</span>
        </div>
        {/* バー行：左=自チームA（右寄せ）、中央区切り、右=相手B（左寄せ） */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 2px 1fr", alignItems:"center", height:8, gap:2 }}>
          {/* A側：右寄せ */}
          <div style={{ display:"flex", justifyContent:"flex-end", height:8, background:"#e8edf3", borderRadius:"4px 0 0 4px", overflow:"hidden" }}>
            <div style={{ width:`${pctA}%`, background:C.teamA, height:"100%", borderRadius:"4px 0 0 4px", transition:"width 0.3s" }}/>
          </div>
          {/* 中央区切り線 */}
          <div style={{ width:2, height:14, background:C.border }}/>
          {/* B側：左寄せ */}
          <div style={{ display:"flex", justifyContent:"flex-start", height:8, background:"#e8edf3", borderRadius:"0 4px 4px 0", overflow:"hidden" }}>
            <div style={{ width:`${pctB}%`, background:C.teamB, height:"100%", borderRadius:"0 4px 4px 0", transition:"width 0.3s" }}/>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:14 }}>
      <MatchSummaryPanel match={match} />

      {/* チーム比較 */}
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,padding:14,marginBottom:12 }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:12 }}>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamA }}>自チーム</span>
          <span style={{ fontSize:11,color:C.textSec }}>チーム比較</span>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamB }}>相手チーム</span>
        </div>
        <Bar a={totalA} b={totalB} label="総ポイント"/>
        <Bar a={winA}   b={winB}   label="決めた得点"/>
        <Bar a={totalA-winA} b={totalB-winB} label="相手ミスで得点"/>
      </div>

      {/* ★自チーム/相手チーム切替タブ */}
      <div style={{ display:"flex",background:"#f0f2f6",padding:3,borderRadius:10,marginBottom:12 }}>
        {[["A","自チーム"],["B","相手チーム"]].map(([t,l])=>(
          <button key={t} style={{ flex:1,padding:7,border:"none",cursor:"pointer",borderRadius:8,fontSize:12,fontWeight:700,background:teamFilter===t?C.white:"transparent",color:teamFilter===t?C.navy:C.textSec,boxShadow:teamFilter===t?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>setTeamFilter(t)}>{l}</button>
        ))}
      </div>

      {/* ★選手別スタッツ（filtered で正しくBも表示） */}
      {filtered.length===0&&(
        <div style={{ textAlign:"center",color:C.textSec,padding:"30px 0" }}>
          <div style={{ fontSize:32,marginBottom:8 }}>📊</div>
          選手データがありません<br/>
          <span style={{ fontSize:12 }}>ポイント記録時に選手を選択すると表示されます</span>
        </div>
      )}
      {filtered.map(p=>{
        const winPlays = Object.entries(p.playsWin).sort((a,b)=>b[1]-a[1]);
        const errPlays = Object.entries(p.playsErr).sort((a,b)=>b[1]-a[1]);
        const hasGoals = p.team==="A" && !!goals; // ★目標は自チームのみ適用
        const pointDiff = p.winners - p.errors;
        const diffGood = hasGoals && goals.goal_point_diff!=null ? pointDiff >= goals.goal_point_diff : pointDiff > 0;
        return (
          <div key={`${p.team}__${p.player_name}`} style={{ ...S.card,marginBottom:10 }}>
            <div style={{ background:p.team==="A"?C.navyMid:C.navy,padding:"8px 12px",display:"flex",alignItems:"center",gap:8 }}>
              <div style={{ width:26,height:26,borderRadius:"50%",background:p.team==="A"?"#2ecc71":"#f97316",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:C.white }}>{p.player_name[0]}</div>
              <span style={{ fontSize:13,fontWeight:700,color:C.white,flex:1 }}>{p.player_name}</span>
              <span style={{ fontSize:10,color:"#8099cc" }}>計 {p.total}pt</span>
            </div>
            <div style={{ padding:12 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10 }}>
                {[
                  ["得点",p.winners,C.accent],
                  ["ミス",p.errors,C.red],
                  ["得点差", pointDiff>=0?`+${pointDiff}`:`${pointDiff}`, diffGood?C.accent:C.red],
                ].map(([l,v,c])=>(
                  <div key={l} style={{ background:`${c}11`,borderRadius:8,padding:"8px 4px",textAlign:"center" }}>
                    <div style={{ fontSize:18,fontWeight:700,color:c }}>{v}</div>
                    <div style={{ fontSize:9,color:C.textSec,fontWeight:700 }}>{l}</div>
                  </div>
                ))}
              </div>
              {/* ★サーブ・レシーブ（2ポイントごとの交代を反映。関与があった選手のみ表示。目標比較で色分け） */}
              {(p.serveTotal>0||p.receiveTotal>0)&&(
                <>
                  <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>🎾 サーブ・レシーブ</div>
                  {p.serveTotal>0&&(()=>{
                    const inCount=p.serveTotal-p.serveFault; const rate=Math.round(inCount/p.serveTotal*100);
                    const good = hasGoals && goals.goal_first_serve_pct!=null ? rate>=goals.goal_first_serve_pct : null;
                    const barColor = good===null?C.accent:(good?C.accent:C.red);
                    return (
                      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4,paddingLeft:10 }}>
                        <span style={{ fontSize:10,color:C.textSec,width:84,flexShrink:0 }}>1stサーブ確率</span>
                        <span style={{ fontSize:11,fontWeight:700,color:good===null?C.navy:(good?C.accent:C.red),whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:4 }}>
                          {inCount}/{p.serveTotal}・{rate}%
                          {good!==null&&<span style={{ fontSize:9,padding:"1px 5px",borderRadius:8,background:good?`${C.accent}22`:`${C.red}22`,color:good?C.accent:C.red }}>{good?"達成":"未達"}</span>}
                        </span>
                        <div style={{ flex:1,maxWidth:"50%",height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${rate}%`,height:"100%",background:barColor,borderRadius:3 }}/></div>
                      </div>
                    );
                  })()}
                  {p.receiveTotal>0&&(()=>{
                    const rate=Math.round(p.receiveMiss/p.receiveTotal*100);
                    const good = hasGoals && goals.goal_receive_miss_pct!=null ? rate<=goals.goal_receive_miss_pct : null;
                    const barColor = good===null?C.red:(good?C.accent:C.red);
                    return (
                      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4,paddingLeft:10 }}>
                        <span style={{ fontSize:10,color:C.textSec,width:84,flexShrink:0 }}>レシーブミス率</span>
                        <span style={{ fontSize:11,fontWeight:700,color:good===null?C.navy:(good?C.accent:C.red),whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:4 }}>
                          {p.receiveMiss}/{p.receiveTotal}・{rate}%
                          {good!==null&&<span style={{ fontSize:9,padding:"1px 5px",borderRadius:8,background:good?`${C.accent}22`:`${C.red}22`,color:good?C.accent:C.red }}>{good?"達成":"未達"}</span>}
                        </span>
                        <div style={{ flex:1,maxWidth:"50%",height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${rate}%`,height:"100%",background:barColor,borderRadius:3 }}/></div>
                      </div>
                    );
                  })()}
                </>
              )}

              {/* ★プレイ結果と内訳（決めた／ミスしたの2グループに分解。目標比較で色分け） */}
              {(winPlays.length>0||errPlays.length>0)&&(
                <div style={{ marginTop:8 }}>
                  <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ結果と内訳</div>
                  {winPlays.length>0&&(()=>{
                    const good = hasGoals && goals.goal_winner_count!=null ? p.winners>=goals.goal_winner_count : null;
                    return (
                      <div style={{ background:C.white,borderRadius:8,padding:"8px 10px",marginBottom:8 }}>
                        <div style={{ fontSize:10,fontWeight:700,color:C.accent,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
                          ✓ 決めたプレイ（{p.winners}回）
                          {good!==null&&<span style={{ fontSize:9,padding:"1px 5px",borderRadius:8,background:good?`${C.accent}22`:`${C.red}22`,color:good?C.accent:C.red }}>目標{goals.goal_winner_count}回以上：{good?"達成":"未達"}</span>}
                        </div>
                        {winPlays.map(([k,n])=>(
                          <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                            <span style={{ fontSize:10,color:C.textSec,width:70,flexShrink:0 }}>{getPlayLabel(k)}</span>
                            <span style={{ fontSize:10,fontWeight:700,color:"#555",flexShrink:0 }}>{n}回</span>
                            <div style={{ flex:1,maxWidth:"50%",height:5,background:"#e8e8e8",borderRadius:3 }}><div style={{ width:`${Math.round(n/p.winners*100)}%`,height:"100%",background:"#7bdba0",borderRadius:3 }}/></div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {errPlays.length>0&&(()=>{
                    const good = hasGoals && goals.goal_error_count!=null ? p.errors<=goals.goal_error_count : null;
                    return (
                      <div style={{ background:C.white,borderRadius:8,padding:"8px 10px" }}>
                        <div style={{ fontSize:10,fontWeight:700,color:C.red,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
                          ✕ ミスしたプレイ（{p.errors}回）
                          {good!==null&&<span style={{ fontSize:9,padding:"1px 5px",borderRadius:8,background:good?`${C.accent}22`:`${C.red}22`,color:good?C.accent:C.red }}>目標{goals.goal_error_count}回以下：{good?"達成":"未達"}</span>}
                        </div>
                        {errPlays.map(([k,n])=>(
                          <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                            <span style={{ fontSize:10,color:C.textSec,width:70,flexShrink:0 }}>{getPlayLabel(k)}</span>
                            <span style={{ fontSize:10,fontWeight:700,color:"#555",flexShrink:0 }}>{n}回</span>
                            <div style={{ flex:1,maxWidth:"50%",height:5,background:"#e8e8e8",borderRadius:3 }}><div style={{ width:`${Math.round(n/p.errors*100)}%`,height:"100%",background:"#f0a49c",borderRadius:3 }}/></div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        );
      })}


      {/* 自動コメント */}
      {comments.length>0&&(
        <div style={{ marginBottom:16 }}>
          {comments.map((c,i)=>(
            <div key={i} style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ fontSize:11,fontWeight:700,color:C.textSec,marginBottom:3 }}>{c.type==="strength"?"💪 強み":"⚠️ 課題"} — {c.player}</div>
              <p style={{ fontSize:12,color:C.navy,lineHeight:1.6 }}>{c.text}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
        <button style={S.btn("#06c755")} onClick={onShareLine}>💬 LINEで結果を共有</button>
        <button style={S.btn(C.navy)} onClick={onDownloadCsv}>📊 CSVをダウンロード</button>
      </div>
    </div>
  );
}

// ============================================================
// App Root
// ============================================================
// ============================================================
// 都道府県リスト（プロフィール登録用）
// ============================================================
const PREFECTURES = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
  "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
  "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県",
  "三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県",
  "徳島県","香川県","愛媛県","高知県",
  "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

// 区分（プロフィール・新規登録共通）
const CATEGORY_OPTIONS = [
  { key: "adult",       label: "社会人"   },
  { key: "university",  label: "大学"     },
  { key: "high_school", label: "高校"     },
  { key: "junior_high", label: "中学校"   },
  { key: "elementary",  label: "小学校"   },
  { key: "other",       label: "その他"   },
];
function categoryLabel(key) {
  return CATEGORY_OPTIONS.find(c => c.key === key)?.label || "";
}

// 男子・女子・共通（プロフィール・新規登録共通）
const GENDER_OPTIONS = [
  { key: "boys",  label: "男子" },
  { key: "girls", label: "女子" },
  { key: "mixed", label: "共通" },
];

// 学校マスター側の男女制限（共学/男子校/女子校）
const GENDER_RESTRICTION_OPTIONS = [
  { key: "mixed", label: "共学・共通" },
  { key: "boys",  label: "男子のみ" },
  { key: "girls", label: "女子のみ" },
];
function genderRestrictionLabel(key) {
  return GENDER_RESTRICTION_OPTIONS.find(g => g.key === key)?.label || "共学・共通";
}
// ユーザーの男女区分（genderCategory）から見て、その学校を選択肢に出してよいか
function schoolMatchesGender(school, genderCategory) {
  const r = school.gender_restriction || "mixed";
  if (r === "mixed") return true;
  if (!genderCategory) return true; // まだ性別未選択の間はすべて表示
  return r === genderCategory;
}

// ============================================================
// プロフィール編集画面
// ============================================================
function ProfileScreen({ onBack, forced, onSaved }) {
  const [ready, setReady] = useState(false);
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [schoolId, setSchoolId] = useState(null);
  const [prefecture, setPrefecture] = useState("東京都");
  const [genderCategory, setGenderCategory] = useState(null);
  const [category, setCategory] = useState(null);
  const [linkedPlayerId, setLinkedPlayerId] = useState(null);
  const [roster, setRoster] = useState([]);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [schools, setSchools] = useState([]);
  const [schoolPrefFilter, setSchoolPrefFilter] = useState("");
  const [linkedPlayerMode, setLinkedPlayerMode] = useState("select");
  const [linkedPlayerLastName, setLinkedPlayerLastName] = useState("");
  const [linkedPlayerFirstName, setLinkedPlayerFirstName] = useState("");
  const [linkedPlayerSaving, setLinkedPlayerSaving] = useState(false);
  // 登録区分: null=未選択, "player"=選手, "guardian"=保護者
  const [registerMode, setRegisterMode] = useState(null);
  const [playerPosition, setPlayerPosition] = useState(null);
  const [playerHand, setPlayerHand] = useState(null);
  const [editingPlayerInfo, setEditingPlayerInfo] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteCodeDisplay, setInviteCodeDisplay] = useState("");
  const [showTransferScreen, setShowTransferScreen] = useState(false);
  const [memberList, setMemberList] = useState([]);
  const [dissolveStep, setDissolveStep] = useState(0); // 0=非表示 1=1回目 2=2回目
  const [dissolving, setDissolving] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [myUserId, setMyUserId] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);

  useEffect(() => { getSchools().then(setSchools); }, []);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await getMyProfile();
      if (cancelled) return;
      if (p) {
        // nameを姓・名に分割（スペース区切り）
        const parts = (p.name ?? "").split(/\s+/);
        setLastName(parts[0] || "");
        setFirstName(parts.slice(1).join(" ") || "");
        setSchoolId(p.school_id ?? null);
        setPrefecture(p.prefecture ?? "東京都");
        setSchoolPrefFilter(p.prefecture ?? "");
        setGenderCategory(p.gender_category ?? null);
        setCategory(p.category ?? null);
        setLinkedPlayerId(p.linked_player_id ?? null);
        setAvatarUrl(p.avatar_url ?? null);
        setIsApproved(!!p.is_approved);
        setMyUserId(p.id);
        if (p.school_id) {
          const info = await getSchoolInviteInfo(p.school_id);
          if (!cancelled && info) {
            setInviteCodeDisplay(info.invite_code || "");
            setIsAdmin(info.admin_user_id === p.id);
          }
        }
      }
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setErrorMsg("");
    const fullName = [lastName.trim(), firstName.trim()].filter(Boolean).join(" ");
    if (!fullName) { setErrorMsg("お名前（姓）を入力してください"); return; }
    if (!schoolId) { setErrorMsg("学校名を選択してください"); return; }
    if (!genderCategory) { setErrorMsg("男子・女子・共通を選択してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    if (!isApproved) {
      const ok = await verifyInviteCode(schoolId, inviteInput);
      if (!ok) { setInviteError("招待コードが正しくありません。管理者に確認してください。"); return; }
    }
    setSaving(true);
    try {
      // ★先に自分のusers行を「承認済み」で確定させる。
      // players（選手マスター）へのINSERTはRLSで「同じチームの承認済みユーザーのみ」という
      // 判定になっており、usersの行がまだ無い/未承認のままだと選手登録が権限エラーで弾かれていた。
      // そのため、選手マスターへの登録より先にプロフィールを保存して承認状態にする。
      await saveMyProfile({ name: fullName, school_id: schoolId, prefecture, gender_category: genderCategory, category, linked_player_id: linkedPlayerId, is_approved: true });
      setIsApproved(true);

      let newLinkedPlayerId = linkedPlayerId;

      // 選手として登録する場合：選手マスターに自動登録
      if (registerMode === "player") {
        const existing = roster.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(fullName) && p.is_own_team && p.school_id === schoolId);
        if (existing) {
          newLinkedPlayerId = existing.id;
          // ポジション・利き手を更新
          if (playerPosition || playerHand) {
            await savePlayer({ ...existing, player_name: fullName, position: playerPosition || existing.position, dominant_hand: playerHand || existing.dominant_hand, is_own_team: true, school_id: schoolId, gender_category: genderCategory });
          }
        } else {
          const saved = await savePlayer({ player_name: fullName, position: playerPosition, dominant_hand: playerHand, is_own_team: true, school_id: schoolId, gender_category: genderCategory });
          const refreshed = await getPlayerRoster();
          setRoster(refreshed);
          const found = refreshed.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(fullName) && p.is_own_team && p.school_id === schoolId);
          if (found) newLinkedPlayerId = found.id;
        }
      }

      if (newLinkedPlayerId !== linkedPlayerId) {
        await saveMyProfile({ name: fullName, school_id: schoolId, prefecture, gender_category: genderCategory, category, linked_player_id: newLinkedPlayerId, is_approved: true });
      }
      setLinkedPlayerId(newLinkedPlayerId);
      onSaved?.();
      onBack();
    } catch (e) {
      setErrorMsg(e.message || "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  // 管理者移譲画面
  if (showTransferScreen) {
    return (
      <div style={S.page}>
        <div style={S.hdr}>
          <div style={{ display:"flex",alignItems:"center",gap:12 }}>
            <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={()=>setShowTransferScreen(false)}>←</button>
            <span style={{ fontSize:18,fontWeight:800,color:C.white }}>管理者を移譲する</span>
          </div>
        </div>
        <div style={{ padding:14 }}>
          <div style={{ background:"#fff3e0",border:"1px solid #ffb74d",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#e65100",marginBottom:14 }}>
            ⚠️ 移譲後は相手が管理者になります。元に戻すには相手の操作が必要です。
          </div>
          <FormSec title="移譲先を選択">
            {memberList.length === 0 ? (
              <div style={{ fontSize:13,color:C.textSec,padding:"8px 0" }}>他の承認済みメンバーがいません。</div>
            ) : memberList.map(m => (
              <div key={m.id} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize:14,fontWeight:700,color:C.text }}>{m.name}</div>
                  <div style={{ fontSize:11,color:C.textSec }}>参加中</div>
                </div>
                <button
                  style={{ background:C.navy,color:C.white,border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",opacity:transferring?0.6:1 }}
                  disabled={transferring}
                  onClick={async () => {
                    if (!window.confirm(`${m.name}さんに管理者を移譲します。\n元に戻すには相手の操作が必要です。\n本当によろしいですか？`)) return;
                    setTransferring(true);
                    try {
                      await transferAdmin(schoolId, m.id);
                      setIsAdmin(false);
                      setShowTransferScreen(false);
                      alert(`${m.name}さんに管理者を移譲しました。`);
                    } catch(e) {
                      alert("移譲に失敗しました: " + (e.message||""));
                    } finally {
                      setTransferring(false);
                    }
                  }}
                >この人に移譲</button>
              </div>
            ))}
          </FormSec>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={S.page}>
        <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      {/* 解散1回目ダイアログ */}
      {dissolveStep === 1 && (
        <div style={{ position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"flex-end",padding:20 }}>
          <div style={{ background:C.white,borderRadius:16,padding:24,width:"100%",display:"flex",flexDirection:"column",gap:16 }}>
            <div style={{ fontSize:16,fontWeight:800,color:C.text,textAlign:"center" }}>🚨 チームを解散しますか？</div>
            <div style={{ fontSize:13,color:C.textSec,textAlign:"center",lineHeight:1.6 }}>解散すると<b style={{color:C.text}}>他の参加者も全員退会</b>となります。<br/>本当に解散しますか？</div>
            <div style={{ display:"flex",gap:10 }}>
              <button style={{ flex:1,background:C.gray,color:C.textSec,border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer" }} onClick={()=>setDissolveStep(0)}>キャンセル</button>
              <button style={{ flex:1,background:C.red,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer" }} onClick={()=>setDissolveStep(2)}>解散する</button>
            </div>
          </div>
        </div>
      )}
      {/* 解散2回目ダイアログ */}
      {dissolveStep === 2 && (
        <div style={{ position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"flex-end",padding:20 }}>
          <div style={{ background:C.white,borderRadius:16,padding:24,width:"100%",display:"flex",flexDirection:"column",gap:16 }}>
            <div style={{ fontSize:16,fontWeight:800,color:C.red,textAlign:"center" }}>🚨 最終確認</div>
            <div style={{ fontSize:13,color:C.textSec,textAlign:"center",lineHeight:1.6 }}>試合・選手マスター・団体戦などの<b style={{color:C.text}}>データもすべて消去</b>となりますが、本当に解散しますか？<br/><br/><span style={{color:C.red,fontWeight:700}}>この操作は元に戻せません。</span></div>
            <div style={{ display:"flex",gap:10 }}>
              <button style={{ flex:1,background:C.gray,color:C.textSec,border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer" }} onClick={()=>setDissolveStep(0)}>キャンセル</button>
              <button
                style={{ flex:1,background:C.red,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",opacity:dissolving?0.6:1 }}
                disabled={dissolving}
                onClick={async ()=>{
                  setDissolving(true);
                  try {
                    await dissolveTeam();
                    await supabase.auth.signOut();
                  } catch(e) {
                    alert("解散に失敗しました: " + (e.message||""));
                    setDissolving(false);
                    setDissolveStep(0);
                  }
                }}
              >{dissolving ? "処理中..." : "解散する"}</button>
            </div>
          </div>
        </div>
      )}

      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          {!forced && <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>}
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>プロフィール</span>
        </div>
        {forced && (
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ background:"none",border:"none",color:"rgba(255,255,255,0.7)",fontSize:13,cursor:"pointer" }} onClick={onBack}>スキップ →</button>
            <button style={{ background:"rgba(255,255,255,0.15)",border:"none",color:"white",fontSize:12,cursor:"pointer",borderRadius:6,padding:"4px 10px" }} onClick={async()=>{ await supabase.auth.signOut(); window.location.reload(); }}>ログアウト</button>
          </div>
        )}
      </div>
      <div style={{ padding:14 }}>
        {forced && (
          <div style={{ background:"#fff3e0",border:"1px solid #ffb74d",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#e65100",marginBottom:14 }}>
            ⚠️ 学校名・男子女子区分の設定が完了していないため、試合の閲覧・作成ができません。設定して保存してください。
          </div>
        )}

        {/* 基本情報（役割バッジ付き） */}
        <div style={{ background:C.white,borderRadius:12,padding:14,marginBottom:12 }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`2px solid ${C.navy}`,paddingBottom:6,marginBottom:12 }}>
            <span style={{ fontSize:12,fontWeight:800,color:C.navy }}>基本情報</span>
            {isApproved && (
              <span style={{ background:isAdmin?"#6366f1":C.textSec,color:C.white,fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20 }}>
                {isAdmin ? "👑 管理者" : "メンバー"}
              </span>
            )}
          </div>
          <div style={{ display:"flex", justifyContent:"center", marginBottom:16 }}>
            <label style={{ position:"relative", cursor:"pointer", display:"inline-block" }}>
              <input
                type="file"
                accept="image/*"
                style={{ display:"none" }}
                onChange={async e=>{
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setAvatarUploading(true);
                  try {
                    const url = await uploadAvatarImage(file);
                    await updateMyAvatar(url);
                    setAvatarUrl(url);
                  } catch(err) {
                    alert("画像のアップロードに失敗しました: " + (err.message || err));
                  } finally {
                    setAvatarUploading(false);
                  }
                }}
              />
              <div style={{ width:88, height:88, borderRadius:"50%", background:C.accentL, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden", border:`2px solid ${C.border}` }}>
                {avatarUploading ? (
                  <span style={{ fontSize:12, color:C.textSec }}>アップロード中…</span>
                ) : avatarUrl ? (
                  <img src={avatarUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                ) : (
                  <span style={{ fontSize:32, color:C.accent }}>{(lastName || "?").charAt(0)}</span>
                )}
              </div>
              <div style={{ position:"absolute", bottom:0, right:0, width:28, height:28, borderRadius:"50%", background:C.navy, color:C.white, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, border:`2px solid ${C.white}` }}>📷</div>
            </label>
          </div>
          <FormRow label="お名前">
            <div style={{ display:"flex", gap:10 }}>
              <div style={{ flex:1 }}>
                <input style={S.inp} placeholder="姓（名字）" value={lastName} onChange={e=>setLastName(e.target.value)} />
              </div>
              <div style={{ flex:1 }}>
                <input style={S.inp} placeholder="名（任意）" value={firstName} onChange={e=>setFirstName(e.target.value)} />
              </div>
            </div>
            <div style={{ fontSize:11, color:"#aaa", marginTop:4 }}>💡 姓だけでも登録できます</div>
          </FormRow>
          <FormRow label="都道府県">
            <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>{ setPrefecture(e.target.value); setSchoolPrefFilter(e.target.value); }}>
              {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FormRow>
          <FormRow label="学校名またはチーム名">
            <SchoolIdSelect value={schoolId} onChange={v=>{ setSchoolId(v); setIsApproved(false); setInviteInput(""); setInviteError(""); }} schools={schools} prefFilter={schoolPrefFilter} genderCategory={genderCategory} />
          </FormRow>
          <FormRow label="男子・女子・共通">
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {GENDER_OPTIONS.map(g => (
                <button key={g.key} style={S.togBtn(genderCategory===g.key)} onClick={()=>setGenderCategory(g.key)}>{g.label}</button>
              ))}
            </div>
          </FormRow>
          <FormRow label="区分">
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {CATEGORY_OPTIONS.map(c => (
                <button key={c.key} style={S.togBtn(category===c.key)} onClick={()=>setCategory(c.key)}>{c.label}</button>
              ))}
            </div>
          </FormRow>

          {/* 招待コード（未承認のみ表示） */}
          {!isApproved && schoolId && (
            <div style={{ background:"#fff8e1",border:"1.5px solid #ffb74d",borderRadius:10,padding:"12px 14px",marginTop:8 }}>
              <div style={{ fontSize:12,fontWeight:700,color:"#e65100",marginBottom:8 }}>🔑 招待コードを入力してください</div>
              <input
                style={{ ...S.inp,textAlign:"center",fontSize:18,fontWeight:800,letterSpacing:6 }}
                placeholder=""
                value={inviteInput}
                maxLength={6}
                onChange={e=>{ setInviteInput(e.target.value.toUpperCase()); setInviteError(""); }}
              />
              {inviteError && <div style={{ fontSize:11,color:C.red,fontWeight:700,marginTop:4 }}>⚠️ {inviteError}</div>}
              <div style={{ fontSize:11,color:C.textSec,marginTop:4 }}>チームの管理者からコードを受け取り入力してください。</div>
            </div>
          )}

          {/* 認証済みバッジ */}
          {isApproved && (
            <div style={{ background:C.accentL,border:`1.5px solid ${C.accent}`,borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:8 }}>
              <span style={{ fontSize:13,fontWeight:700,color:C.navy }}>🔑 招待コード認証済み</span>
              <span style={{ background:C.accent,color:C.white,fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20 }}>✓ 参加中</span>
            </div>
          )}

          {/* 選手登録セクション */}
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14, marginTop:4 }}>
            {linkedPlayerId ? (
              /* 登録済み表示 */
              (() => {
                const linkedPlayer = roster.find(p => p.id === linkedPlayerId);
                return linkedPlayer ? (
                  <div>
                    <div style={{ background:"#eef1f8", border:`1.5px solid ${C.navy}`, borderRadius:10, padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
                      <div>
                        <div style={{ fontSize:10, fontWeight:700, color:C.navy, marginBottom:2 }}>
                          {linkedPlayer.linked_user_id ? "✅ 選手として登録済み" : "✅ 関連選手として登録済み"}
                        </div>
                        <div style={{ fontSize:15, fontWeight:800, color:C.navy }}>{linkedPlayer.player_name}</div>
                        <div style={{ fontSize:11, color:C.textSec }}>
                          {[linkedPlayer.position, linkedPlayer.dominant_hand==="right"?"右利き":linkedPlayer.dominant_hand==="left"?"左利き":null].filter(Boolean).join("・") || "未設定"}
                        </div>
                      </div>
                      {!editingPlayerInfo && (
                        <button
                          style={{ flexShrink:0, background:C.navy, border:"none", borderRadius:8, padding:"6px 10px", fontSize:11, fontWeight:700, color:"white", cursor:"pointer", whiteSpace:"nowrap" }}
                          onClick={()=>setEditingPlayerInfo(true)}
                        >✏️ 修正</button>
                      )}
                    </div>

                    {/* 修正モーダル */}
                    {editingPlayerInfo && (
                      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:200 }} onClick={e=>{ if(e.target===e.currentTarget) setEditingPlayerInfo(false); }}>
                        <div style={{ background:"white", borderRadius:"20px 20px 0 0", padding:20, width:"100%", maxWidth:480 }}>
                          <div style={{ width:40, height:4, background:"#ddd", borderRadius:2, margin:"0 auto 16px" }} />
                          <div style={{ fontSize:17, fontWeight:800, color:C.navy, marginBottom:4 }}>✏️ 選手情報を修正</div>
                          <div style={{ fontSize:12, color:C.textSec, marginBottom:14 }}>修正内容は選手マスターにも反映されます</div>
                          <div style={{ height:1, background:C.border, marginBottom:14 }} />
                          {/* 名前（変更不可） */}
                          <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>お名前（変更不可）</div>
                          <div style={{ fontSize:16, fontWeight:700, color:"#bbb", borderBottom:`1px solid ${C.border}`, paddingBottom:8, marginBottom:14 }}>
                            {linkedPlayer.player_name} 🔒
                          </div>
                          <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>ポジション</div>
                          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
                            {["前衛","後衛"].map(v => (
                              <button key={v} style={S.togBtn(playerPosition===v)} onClick={()=>setPlayerPosition(playerPosition===v?null:v)}>{v}</button>
                            ))}
                          </div>
                          <div style={{ fontSize:11, color:C.textSec, marginBottom:8 }}>利き手</div>
                          <div style={{ display:"flex", gap:8, marginBottom:16 }}>
                            {["右","左"].map(v => (
                              <button key={v} style={S.togBtn(playerHand===v)} onClick={()=>setPlayerHand(playerHand===v?null:v)}>{v}</button>
                            ))}
                          </div>
                          <div style={{ height:1, background:C.border, marginBottom:14 }} />
                          <button
                            style={{ display:"block", width:"100%", padding:14, background:C.accent, color:"white", fontSize:15, fontWeight:700, border:"none", borderRadius:12, cursor:"pointer", marginBottom:10 }}
                            onClick={async()=>{
                              try {
                                await savePlayer({ ...linkedPlayer, position: playerPosition, dominant_hand: playerHand });
                                const refreshed = await getPlayerRoster();
                                setRoster(refreshed);
                                setEditingPlayerInfo(false);
                              } catch(e) {
                                alert("更新に失敗しました: " + e.message);
                              }
                            }}
                          >修正を保存する</button>
                          <button
                            style={{ display:"block", width:"100%", padding:12, background:"none", border:`1.5px solid ${C.border}`, borderRadius:12, fontSize:14, color:C.textSec, cursor:"pointer" }}
                            onClick={()=>setEditingPlayerInfo(false)}
                          >キャンセル</button>
                          <div style={{ fontSize:11, color:"#aaa", textAlign:"center", marginTop:8 }}>※ 選手マスターのデータも更新されます</div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null;
              })()
            ) : (
              /* 未登録：登録フォーム */
              <div>
                <div style={{ fontSize:12, color:C.orange, marginBottom:10 }}>
                  ⚠️ 登録した名前は後から変更できません。
                </div>
                <div style={{ fontSize:12, color:C.textSec, marginBottom:12 }}>
                  まだ選手登録されていません。登録すると戦績をホーム画面で確認できます。
                </div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:C.textSec }}>登録区分を選んでください</div>
                  {registerMode && (
                    <button style={{ fontSize:12, color:C.textSec, background:"none", border:"none", cursor:"pointer", textDecoration:"underline" }} onClick={()=>setRegisterMode(null)}>選択をリセット</button>
                  )}
                </div>

                {/* ブロックA: 選手 */}
                <div onClick={()=>{ if(registerMode!=="player") setRegisterMode("player"); }} style={{ border:`1.5px solid ${registerMode==="player" ? C.navy : C.border}`, borderRadius:10, marginBottom:8, overflow:"hidden", cursor:"pointer", opacity:registerMode==="guardian"?0.4:1, pointerEvents:registerMode==="guardian"?"none":"auto", transition:"opacity 0.2s" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:registerMode==="player"?"#eef1f8":"#fafafa" }}>
                    <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${registerMode==="player"?C.navy:"#ccc"}`, background:registerMode==="player"?C.navy:"white", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {registerMode==="player" && <div style={{ width:8, height:8, borderRadius:"50%", background:"white" }} />}
                    </div>
                    <div>
                      <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>🎾 選手として登録する</div>
                      <div style={{ fontSize:11, color:C.textSec, marginTop:2 }}>自分自身が選手です（部員・選手本人）</div>
                    </div>
                  </div>
                  {registerMode==="player" && (
                    <div style={{ padding:"12px 14px", borderTop:`1px solid ${C.border}` }} onClick={e=>e.stopPropagation()}>
                      <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>ポジション（任意）</div>
                      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                        {["前衛","後衛"].map(v => <button key={v} style={S.togBtn(playerPosition===v)} onClick={()=>setPlayerPosition(playerPosition===v?null:v)}>{v}</button>)}
                      </div>
                      <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>利き手（任意）</div>
                      <div style={{ display:"flex", gap:8 }}>
                        {["右","左"].map(v => <button key={v} style={S.togBtn(playerHand===v)} onClick={()=>setPlayerHand(playerHand===v?null:v)}>{v}</button>)}
                      </div>
                    </div>
                  )}
                </div>

                {/* ブロックB: 保護者・関係者 */}
                <div onClick={()=>{ if(registerMode!=="guardian") setRegisterMode("guardian"); }} style={{ border:`1.5px solid ${registerMode==="guardian"?C.navy:C.border}`, borderRadius:10, overflow:"hidden", cursor:"pointer", opacity:registerMode==="player"?0.4:1, pointerEvents:registerMode==="player"?"none":"auto", transition:"opacity 0.2s" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:registerMode==="guardian"?"#eef1f8":"#fafafa" }}>
                    <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${registerMode==="guardian"?C.navy:"#ccc"}`, background:registerMode==="guardian"?C.navy:"white", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {registerMode==="guardian" && <div style={{ width:8, height:8, borderRadius:"50%", background:"white" }} />}
                    </div>
                    <div>
                      <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>👤 保護者・関係者として登録する</div>
                      <div style={{ fontSize:11, color:C.textSec, marginTop:2 }}>お子さんや関連選手の戦績を確認したい方</div>
                    </div>
                  </div>
                  {registerMode==="guardian" && (
                    <div style={{ padding:"12px 14px", borderTop:`1px solid ${C.border}` }} onClick={e=>e.stopPropagation()}>
                      <div style={{ display:"flex", gap:10, marginBottom:4 }}>
                        <input style={{ ...S.inp, flex:1 }} placeholder="姓（名字）" value={linkedPlayerLastName} onChange={e=>setLinkedPlayerLastName(e.target.value)}/>
                        <input style={{ ...S.inp, flex:1 }} placeholder="名（任意）" value={linkedPlayerFirstName} onChange={e=>setLinkedPlayerFirstName(e.target.value)}/>
                      </div>
                      <div style={{ fontSize:11, color:"#aaa", marginBottom:10 }}>💡 姓だけでも登録できます</div>
                      <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>ポジション（任意）</div>
                      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                        {["前衛","後衛"].map(v => <button key={v} style={S.togBtn(playerPosition===v)} onClick={()=>setPlayerPosition(playerPosition===v?null:v)}>{v}</button>)}
                      </div>
                      <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>利き手（任意）</div>
                      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                        {["右","左"].map(v => <button key={v} style={S.togBtn(playerHand===v)} onClick={()=>setPlayerHand(playerHand===v?null:v)}>{v}</button>)}
                      </div>
                      <button
                        style={{ background:C.accent, color:C.white, border:"none", borderRadius:8, padding:"10px 14px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:linkedPlayerSaving?0.6:1, width:"100%" }}
                        disabled={linkedPlayerSaving || !linkedPlayerLastName.trim()}
                        onClick={async()=>{
                          const pname = [linkedPlayerLastName.trim(), linkedPlayerFirstName.trim()].filter(Boolean).join(" ");
                          if (!pname) return;
                          setLinkedPlayerSaving(true);
                          try {
                            const existing = roster.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(pname) && p.is_own_team && p.school_id === schoolId);
                            if (existing) { setLinkedPlayerId(existing.id); }
                            else {
                              await savePlayer({ player_name: pname, position: playerPosition, dominant_hand: playerHand, is_own_team: true, school_id: schoolId, gender_category: genderCategory });
                              const refreshed = await getPlayerRoster();
                              setRoster(refreshed);
                              const saved = refreshed.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(pname) && p.is_own_team && p.school_id === schoolId);
                              if (saved) setLinkedPlayerId(saved.id);
                            }
                            setLinkedPlayerLastName(""); setLinkedPlayerFirstName("");
                            setPlayerPosition(null); setPlayerHand(null);
                            setRegisterMode(null);
                          } catch(e) { setErrorMsg("選手登録に失敗しました: "+(e.message||"")); }
                          finally { setLinkedPlayerSaving(false); }
                        }}
                      >{linkedPlayerSaving?"登録中…":"登録して選択"}</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 招待コード説明 */}
        <div style={{ background:"#f5f5f5",border:"1px solid #e0e0e0",borderRadius:10,padding:"10px 14px",fontSize:12,color:C.textSec,marginBottom:12 }}>
          ℹ️ 学校名を変更すると、共有される試合・選手マスターの範囲が変わります。
        </div>

        {errorMsg && (
          <div style={{ background:C.redL, color:C.red, fontSize:12, padding:"10px 14px", borderRadius:10, marginBottom:12, fontWeight:700 }}>⚠️ {errorMsg}</div>
        )}

        <button
          style={{ ...S.btn(saving ? C.border : `linear-gradient(135deg,${C.accent},#00a066)`), color: saving?C.textSec:C.white }}
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "保存中..." : "保存する"}
        </button>

        {/* ログアウトボタン（常に表示） */}
        <button
          style={{ display:"block", width:"100%", marginTop:12, padding:"14px", background:"none", border:`1.5px solid ${C.border}`, borderRadius:12, fontSize:15, fontWeight:700, color:C.textSec, cursor:"pointer" }}
          onClick={async()=>{ if(window.confirm("ログアウトしますか？")) { await supabase.auth.signOut(); window.location.reload(); } }}
        >ログアウト</button>

        {!forced && (
          <div style={{ marginTop:32, borderTop:`1px solid ${C.border}`, paddingTop:20, display:"flex", flexDirection:"column", gap:12 }}>

            {/* 管理者メニュー（保存ボタンの下） */}
            {isAdmin && isApproved && (
              <div style={{ background:C.white,borderRadius:12,padding:14 }}>
                <div style={{ fontSize:12,fontWeight:800,color:C.navy,borderBottom:`2px solid ${C.navy}`,paddingBottom:6,marginBottom:12 }}>👑 管理者メニュー</div>
                <div style={{ background:"#f0f4ff",border:"1.5px solid #6366f1",borderRadius:10,padding:"12px 14px",marginBottom:10 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:"#6366f1",marginBottom:8 }}>チームの招待コード</div>
                  <div style={{ background:C.white,border:"1.5px dashed #6366f1",borderRadius:8,padding:14,textAlign:"center",fontSize:24,fontWeight:800,letterSpacing:8,color:C.navy,marginBottom:8 }}>{inviteCodeDisplay}</div>
                  <div style={{ display:"flex",gap:8,marginBottom:8 }}>
                    <button
                      style={{ flex:1,background:"#6366f1",color:C.white,border:"none",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer" }}
                      onClick={()=>{ navigator.clipboard?.writeText(inviteCodeDisplay); alert("招待コードをコピーしました！"); }}
                    >📋 コードをコピー</button>
                    <button
                      style={{ flex:1,background:C.white,color:"#6366f1",border:"1.5px solid #6366f1",borderRadius:8,padding:"10px 0",fontSize:13,fontWeight:700,cursor:"pointer" }}
                      onClick={async ()=>{
                        if (!window.confirm("招待コードを再発行しますか？\n古いコードは使えなくなりますが、既存メンバーへの影響はありません。")) return;
                        try {
                          const newCode = await reissueInviteCode(schoolId);
                          setInviteCodeDisplay(newCode);
                          alert("招待コードを再発行しました。");
                        } catch(e) { alert("再発行に失敗しました: " + (e.message||"")); }
                      }}
                    >🔄 再発行</button>
                  </div>
                  <div style={{ fontSize:11,color:C.textSec }}>このコードをLINEなどで部員に共有してください。再発行しても既存メンバーへの影響はありません。</div>
                </div>
                {/* 管理者を移譲する */}
                <button
                  style={{ width:"100%",background:C.white,color:C.text,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"12px 14px",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"left" }}
                  onClick={async ()=>{
                    const members = await getApprovedMembers();
                    setMemberList(members);
                    setShowTransferScreen(true);
                  }}
                >👤 管理者を移譲する ›</button>
              </div>
            )}

            {/* アカウントを削除する */}
            {isAdmin ? (
              <>
                <button style={{ ...S.btn("transparent"), color:C.textSec, border:`1px solid ${C.border}`, fontSize:13, opacity:0.5, cursor:"not-allowed" }} disabled>
                  🗑 アカウントを削除する
                </button>
                <div style={{ fontSize:11, color:C.red, marginTop:-8, textAlign:"center", fontWeight:700 }}>
                  ※先に管理者を移譲してください
                </div>
              </>
            ) : (
              <>
                <button
                  style={{ ...S.btn("transparent"), color:C.red, border:`1px solid ${C.red}`, fontSize:13 }}
                  onClick={async ()=>{
                    if (!window.confirm("アカウントを削除しますか？\n\n※試合データは削除されません。\nこの操作は取り消せません。")) return;
                    if (!window.confirm("本当に削除しますか？\nアカウントは完全に削除されます。")) return;
                    try {
                      const { error } = await supabase.rpc("delete_my_account");
                      if (error) throw error;
                      await supabase.auth.signOut();
                    } catch(e) {
                      alert("削除に失敗しました: " + (e.message || e));
                    }
                  }}
                >
                  🗑 アカウントを削除する
                </button>
                <div style={{ fontSize:11, color:C.textSec, marginTop:-8, textAlign:"center" }}>
                  ※試合データは削除されません
                </div>
              </>
            )}

            {/* チームを解散する（管理者のみ・一番下） */}
            {isAdmin && isApproved && (
              <>
                <button
                  style={{ width:"100%",background:C.white,color:C.red,border:`1.5px solid ${C.red}`,borderRadius:8,padding:"12px 14px",fontSize:13,fontWeight:700,cursor:"pointer",textAlign:"center" }}
                  onClick={()=>setDissolveStep(1)}
                >🚨 チームを解散する ›</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 選手マスター画面（同じ学校のメンバーで共有）
// ============================================================
const POSITIONS = ["前衛", "後衛", "その他"];
function PositionButtons({ value, onChange }) {
  return (
    <div style={{ display:"flex", gap:6 }}>
      {POSITIONS.map(pos => (
        <button key={pos} style={{ flex:1, padding:"8px 4px", fontSize:12, borderRadius:8, border:"none", cursor:"pointer",
          background: value===pos ? C.navy : C.gray, color: value===pos ? C.white : C.text, fontWeight: value===pos ? 700 : 400 }}
          onClick={() => onChange(value===pos ? "" : pos)}>{pos}</button>
      ))}
    </div>
  );
}
function HandButtons({ value, onChange }) {
  return (
    <div style={{ display:"flex", gap:6 }}>
      {[["right","右利き"],["left","左利き"]].map(([k,l]) => (
        <button key={k} style={{ flex:1, padding:"8px 4px", fontSize:12, borderRadius:8, border:"none", cursor:"pointer",
          background: value===k ? C.accent : C.gray, color: value===k ? C.white : C.text, fontWeight: value===k ? 700 : 400 }}
          onClick={() => onChange(value===k ? "" : k)}>{l}</button>
      ))}
    </div>
  );
}
function PlayerRosterScreen({ onBack }) {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("own"); // own | other
  const [schools, setSchools] = useState([]);
  const [mySchoolName, setMySchoolName] = useState("");
  const [filterSchool, setFilterSchool] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newFirstName, setNewFirstName] = useState("");
  const [schoolPrefFilter, setSchoolPrefFilter] = useState("");
  const [newPosition, setNewPosition] = useState("");
  const [showNewSchoolInput, setShowNewSchoolInput] = useState(false); // ★一覧に無い新しい対戦相手の学校を、検索入力で追加する時だけ表示
  const [newDominantHand, setNewDominantHand] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editLastName, setEditLastName] = useState("");
  const [editFirstName, setEditFirstName] = useState("");
  const [editPosition, setEditPosition] = useState("");
  const [editTeamName, setEditTeamName] = useState("");
  const [editDominantHand, setEditDominantHand] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [nameSearch, setNameSearch] = useState(""); // ★学校を問わず選手名で直接検索するための入力

  const reload = useCallback(() => {
    setLoading(true);
    getPlayerRoster().then(list => { setPlayers(list); setLoading(false); });
  }, []);

  useEffect(() => {
    reload();
    getSchools().then(list => {
      setSchools(list);
      getMyProfile().then(p => {
        if (p?.school_id) {
          const s = list.find(s => s.id === p.school_id);
          if (s) setMySchoolName(s.name);
        }
      });
    });
  }, [reload]);

  const ownPlayers = players.filter(p => p.is_own_team !== false);
  const otherPlayers = players.filter(p => p.is_own_team === false);
  const otherSchoolNames = [...new Set(otherPlayers.map(p => p.team_name).filter(Boolean))].sort();
  const visibleOtherPlayers = filterSchool ? otherPlayers.filter(p => p.team_name === filterSchool) : otherPlayers;
  const availablePrefs = [...new Set(schools.map(s => s.prefecture).filter(Boolean))].sort();
  // ★登録済みの対戦相手の学校名 → 都道府県 の対応表（都道府県チップでの絞り込み用）
  const schoolPrefByName = {};
  schools.forEach(s => { schoolPrefByName[s.name] = s.prefecture; });
  const filteredOtherSchoolNames = schoolPrefFilter
    ? otherSchoolNames.filter(n => schoolPrefByName[n] === schoolPrefFilter)
    : otherSchoolNames;

  const handLabel = (k) => k==="right" ? "右利き" : k==="left" ? "左利き" : "";

  async function handleAdd() {
    setErrorMsg("");
    const fullName = [newLastName.trim(), newFirstName.trim()].filter(Boolean).join(" ");
    if (!fullName) return;
    try {
      const finalTeamName = tab==="own" ? mySchoolName : filterSchool;
      if (tab==="other" && !finalTeamName.trim()) { setErrorMsg("学校を選択してください"); return; }
      // ★「他チーム」で自チームと同じ学校名を入力した場合は自動的に自チーム扱いにする
      const isOwn = tab==="own" || (!!mySchoolName && finalTeamName.trim() === mySchoolName.trim());
      await savePlayer({ player_name: fullName, position: newPosition || null, dominant_hand: newDominantHand || null, is_own_team: isOwn, team_name: finalTeamName });
      // ★学校の選択（filterSchool）はリセットしない → 同じ学校の選手を続けて登録しやすくする
      setNewLastName(""); setNewFirstName(""); setNewPosition(""); setNewDominantHand("");
      reload();
    } catch (e) { setErrorMsg("追加に失敗しました: " + (e.message || JSON.stringify(e))); }
  }
  async function handleUpdate(id) {
    setErrorMsg("");
    const fullName = [editLastName.trim(), editFirstName.trim()].filter(Boolean).join(" ");
    if (!fullName) return;
    try {
      const finalTeamName = editTeamName;
      // ★学校名が自チームと同じかどうかで自チーム／他チームを判定する（タブではなく実際の学校名で判定）
      const isOwn = !!mySchoolName && finalTeamName.trim() === mySchoolName.trim();
      const oldName = players.find(p => p.id === id)?.player_name;
      await savePlayer({ id, player_name: fullName, position: editPosition || null, dominant_hand: editDominantHand || null, is_own_team: isOwn, team_name: finalTeamName });
      // ★名前を変更した場合、過去の試合記録（そのチーム側の出場分）にも反映する
      if (oldName && oldName !== fullName) {
        try {
          const n = await renamePlayerEverywhere(oldName, fullName, isOwn ? "A" : "B", isOwn ? null : finalTeamName);
          if (n === 0) {
            alert(`選手情報は更新しましたが、「${oldName}」名義の過去の試合記録は見つかりませんでした。`);
          }
        } catch (renameErr) {
          alert("選手情報は更新しましたが、過去の試合記録への反映でエラーが起きました:\n" + (renameErr.message || renameErr));
        }
      }
      setEditingId(null); reload();
    } catch (e) { setErrorMsg("更新に失敗しました: " + (e.message || JSON.stringify(e))); }
  }
  function startEdit(p) {
    setEditingId(p.id);
    const parts = (p.player_name || "").trim().split(/\s+/);
    setEditLastName(parts[0] || "");
    setEditFirstName(parts.slice(1).join(" ") || "");
    setEditPosition(p.position||"");
    setEditTeamName(p.team_name||"");
    setEditDominantHand(p.dominant_hand||"");
  }
  async function handleDelete(id) {
    if (!window.confirm("この選手をマスターから削除しますか？")) return;
    setErrorMsg("");
    try { await deletePlayerFromRoster(id); reload(); }
    catch (e) { setErrorMsg("削除に失敗しました: " + (e.message || e)); }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button style={{ background:"none", border:"none", color:C.white, fontSize:20, cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18, fontWeight:800, color:C.white }}>選手マスター</span>
        </div>
      </div>
      <div style={{ display:"flex", gap:6, padding:"12px 14px 0" }}>
        {[["own","自チーム"],["other","他チーム"]].map(([v,l])=>(
          <button key={v} style={{ ...S.togBtn(tab===v,C.navy), flex:1, fontSize:13, padding:"9px 4px" }}
            onClick={()=>{ setTab(v); setEditingId(null); setFilterSchool(""); setShowNewSchoolInput(false); }}>{l}</button>
        ))}
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:"#f5f5f5", border:"1px solid #e0e0e0", borderRadius:10, padding:"10px 14px", fontSize:12, color:C.textSec, marginBottom:14 }}>
          {tab==="own" ? "ℹ️ ここで登録した選手は、同じ学校のメンバー全員が試合作成時に「自チーム」として選べます。" : "ℹ️ 対戦相手の選手を登録しておくと、試合作成時に「相手チーム」として選べ、対戦相手別の分析もしやすくなります。"}
        </div>

        {/* ★学校を問わず、選手名で直接検索・削除できるようにする（誤登録を素早く探す用） */}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>選手名で検索（学校を問わず、このタブ内の全選手が対象）</div>
          <input style={S.inp} placeholder="例：前衛" value={nameSearch} onChange={e=>setNameSearch(e.target.value)} />
          {nameSearch.trim() && (
            <div style={{ ...S.card, marginTop:10, padding:0 }}>
              {(tab==="own" ? ownPlayers : otherPlayers).filter(p => p.player_name.includes(nameSearch.trim())).length===0 ? (
                <div style={{ padding:14, fontSize:12, color:C.textSec, textAlign:"center" }}>該当する選手が見つかりません</div>
              ) : (tab==="own" ? ownPlayers : otherPlayers).filter(p => p.player_name.includes(nameSearch.trim())).map(p=>(
                <div key={p.id} style={{ display:"flex", alignItems:"center", padding:"12px 14px", gap:10, borderBottom:`1px solid ${C.border}` }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{p.player_name}</div>
                    <div style={{ fontSize:11, color:C.textSec }}>{[p.team_name, p.position, handLabel(p.dominant_hand)].filter(Boolean).join(" ・ ")}</div>
                  </div>
                  <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer", color:C.red }} onClick={()=>handleDelete(p.id)}>🗑</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ★他チームタブ：先に都道府県→学校をチップで選び、登録済み選手を確認してから選手名を入力する流れ */}
        {tab==="other" && (
          <>
            {availablePrefs.length > 0 && otherSchoolNames.length > 0 && (
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>都道府県で絞り込み</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  <button style={{ ...S.togBtn(schoolPrefFilter==="", C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>setSchoolPrefFilter("")}>すべて</button>
                  {availablePrefs.map(pref=>(
                    <button key={pref} style={{ ...S.togBtn(schoolPrefFilter===pref, C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>setSchoolPrefFilter(pref)}>{pref}</button>
                  ))}
                </div>
              </div>
            )}

            {otherSchoolNames.length > 0 && (
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>学校で絞り込み</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  <button style={{ ...S.togBtn(filterSchool==="" && !showNewSchoolInput, C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>{ setFilterSchool(""); setShowNewSchoolInput(false); }}>すべて</button>
                  {filteredOtherSchoolNames.map(name=>(
                    <button key={name} style={{ ...S.togBtn(filterSchool===name && !showNewSchoolInput, C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>{ setFilterSchool(name); setShowNewSchoolInput(false); }}>{name}</button>
                  ))}
                  <button style={{ ...S.togBtn(showNewSchoolInput, C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>{ setShowNewSchoolInput(v=>!v); setFilterSchool(""); }}>＋ 新しい学校</button>
                </div>
              </div>
            )}

            {(showNewSchoolInput || otherSchoolNames.length===0) && (
              <div style={{ marginBottom:12 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                  <div style={{ fontSize:11, color:C.textSec }}>新しい対戦相手の学校を検索</div>
                  <PrefMiniFilter value={schoolPrefFilter} onChange={setSchoolPrefFilter} options={availablePrefs} />
                </div>
                <SchoolField value={filterSchool} onChange={setFilterSchool} schools={schools} prefFilter={schoolPrefFilter} placeholder="学校名を入力"/>
              </div>
            )}

          </>
        )}

        {tab==="other" && filterSchool && (
          <div style={{ marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontSize:12, fontWeight:800, color:C.textSec }}>{filterSchool} の登録済み選手</div>
              <div style={{ fontSize:11, color:C.textSec, fontWeight:700 }}>{visibleOtherPlayers.length}人</div>
            </div>
            {visibleOtherPlayers.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"14px 0", fontSize:12 }}>まだ登録されていません</div>}
            {visibleOtherPlayers.map(p => (
              <div key={p.id} style={S.card}>
                {editingId===p.id ? (
                  <div style={{ padding:12 }}>
                    <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                      <input style={{ ...S.inp, flex:1 }} placeholder="姓" value={editLastName} onChange={e=>setEditLastName(e.target.value)} />
                      <input style={{ ...S.inp, flex:1 }} placeholder="名（任意）" value={editFirstName} onChange={e=>setEditFirstName(e.target.value)} />
                    </div>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                      <div style={{ fontSize:11, color:C.textSec }}>学校名・チーム名</div>
                      <PrefMiniFilter value={schoolPrefFilter} onChange={setSchoolPrefFilter} options={availablePrefs} />
                    </div>
                    <div style={{ marginBottom:8 }}>
                      <SchoolField value={editTeamName} onChange={setEditTeamName} schools={schools} prefFilter={schoolPrefFilter} placeholder="学校名を入力"/>
                    </div>
                    <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>ポジション</div>
                    <div style={{ marginBottom:8 }}><PositionButtons value={editPosition} onChange={setEditPosition} /></div>
                    <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>利き手</div>
                    <div style={{ marginBottom:10 }}><HandButtons value={editDominantHand} onChange={setEditDominantHand} /></div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:12 }} onClick={()=>setEditingId(null)}>キャンセル</button>
                      <button style={{ ...S.btn(C.accent), fontSize:12 }} onClick={()=>handleUpdate(p.id)}>保存</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display:"flex", alignItems:"center", padding:"12px 14px", gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{p.player_name}</div>
                      <div style={{ fontSize:11, color:C.textSec }}>{[p.team_name, p.position, handLabel(p.dominant_hand)].filter(Boolean).join(" ・ ")}</div>
                    </div>
                    <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer" }} onClick={()=>startEdit(p)}>✏️</button>
                    <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer", color:C.red }} onClick={()=>handleDelete(p.id)}>🗑</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <FormSec title={tab==="own" ? "自チームの選手を追加" : (filterSchool ? `${filterSchool} に選手を追加` : "他チームの選手を追加")}>
          <FormRow label="選手名">
            <div style={{ display:"flex", gap:8 }}>
              <input style={{ ...S.inp, flex:1 }} placeholder="姓（例：田中）" value={newLastName} onChange={e=>setNewLastName(e.target.value)} />
              <input style={{ ...S.inp, flex:1 }} placeholder="名（例：蓮・任意）" value={newFirstName} onChange={e=>setNewFirstName(e.target.value)} />
            </div>
          </FormRow>
          {tab==="own" && (
            <FormRow label="学校名・チーム名">
              <div style={{ ...S.inp, background:C.gray, color:C.textSec, display:"flex", alignItems:"center" }}>{mySchoolName || "（プロフィールから自動入力）"}</div>
            </FormRow>
          )}
          <FormRow label="ポジション（任意）">
            <PositionButtons value={newPosition} onChange={setNewPosition} />
          </FormRow>
          <FormRow label="利き手（任意）">
            <HandButtons value={newDominantHand} onChange={setNewDominantHand} />
          </FormRow>
        </FormSec>
        {errorMsg && <div style={{ color:C.red, fontSize:12, marginBottom:10 }}>{errorMsg}</div>}
        <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:16 }} onClick={handleAdd}>＋ 追加する</button>

        {loading && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>読み込み中...</div>}
        {!loading && tab==="own" && ownPlayers.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>登録されている選手がいません</div>}

        {tab==="own" && ownPlayers.map(p => (
          <div key={p.id} style={S.card}>
            {editingId===p.id ? (
              <div style={{ padding:12 }}>
                <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                  <input style={{ ...S.inp, flex:1 }} placeholder="姓" value={editLastName} onChange={e=>setEditLastName(e.target.value)} />
                  <input style={{ ...S.inp, flex:1 }} placeholder="名（任意）" value={editFirstName} onChange={e=>setEditFirstName(e.target.value)} />
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                  <div style={{ fontSize:11, color:C.textSec }}>学校名・チーム名</div>
                  <PrefMiniFilter value={schoolPrefFilter} onChange={setSchoolPrefFilter} options={availablePrefs} />
                </div>
                <div style={{ marginBottom:8 }}>
                  <SchoolField value={editTeamName} onChange={setEditTeamName} schools={schools} prefFilter={schoolPrefFilter} placeholder="学校名を入力"/>
                </div>
                {editTeamName.trim() !== mySchoolName.trim() && editTeamName.trim() !== "" && (
                  <div style={{ fontSize:11, color:C.orange, marginBottom:8 }}>⚠️ 自チーム（{mySchoolName}）と異なる学校名です。保存すると「他チーム」に移動します。</div>
                )}
                <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>ポジション</div>
                <div style={{ marginBottom:8 }}><PositionButtons value={editPosition} onChange={setEditPosition} /></div>
                <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>利き手</div>
                <div style={{ marginBottom:10 }}><HandButtons value={editDominantHand} onChange={setEditDominantHand} /></div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:12 }} onClick={()=>setEditingId(null)}>キャンセル</button>
                  <button style={{ ...S.btn(C.accent), fontSize:12 }} onClick={()=>handleUpdate(p.id)}>保存</button>
                </div>
              </div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", padding:"12px 14px", gap:10 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{p.player_name}</div>
                  <div style={{ fontSize:11, color:C.textSec }}>{[p.team_name, p.position, handLabel(p.dominant_hand)].filter(Boolean).join(" ・ ")}</div>
                </div>
                <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer" }} onClick={()=>startEdit(p)}>✏️</button>
                <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer", color:C.red }} onClick={()=>handleDelete(p.id)}>🗑</button>
              </div>
            )}
          </div>
        ))}

      </div>
    </div>
  );
}

// ============================================================
// 学校マスター管理画面（管理者専用）
// ============================================================
function AdminSchoolsScreen({ onBack }) {
  const [schools, setSchools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newPrefecture, setNewPrefecture] = useState("");
  const [newCategory, setNewCategory] = useState(null);
  const [newGenderRestriction, setNewGenderRestriction] = useState("mixed");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editPrefecture, setEditPrefecture] = useState("");
  const [editCategory, setEditCategory] = useState(null);
  const [editGenderRestriction, setEditGenderRestriction] = useState("mixed");
  const [errorMsg, setErrorMsg] = useState("");
  const [listPrefFilter, setListPrefFilter] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getSchools(true);
      setSchools(list);
      // ★管理画面は「今のDBの正しい状態」を見る場所なので、
      //   古いキャッシュを使い回さず必ずサーバーへ再取得しにいく（force=true）
    } catch (e) {
      console.error("学校マスターの再読み込みに失敗しました:", e);
      alert("学校一覧の取得に失敗しました。\n通信状態を確認して、もう一度再読み込みしてください。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function handleAdd() {
    setErrorMsg("");
    if (!newName.trim()) return;
    if (!newCategory) { setErrorMsg("区分（高校・中学校など）を選択してください"); return; }
    try {
      await addSchool(newName.trim(), newPrefecture.trim(), newCategory, newGenderRestriction);
      setNewName(""); setNewPrefecture(""); setNewCategory(null); setNewGenderRestriction("mixed");
      reload();
    } catch (e) {
      console.error("学校追加エラー（詳細）:", e);
      const friendly = e.message?.includes("duplicate") ? "同じ名前・同じ区分の学校がすでに登録されています" : (e.message || "追加に失敗しました");
      setErrorMsg(friendly + " [詳細] " + (e.message||"") + " / " + (e.details||"") + " / " + (e.hint||""));
    }
  }

  async function handleUpdate(id) {
    setErrorMsg("");
    if (!editName.trim()) return;
    if (!editCategory) { setErrorMsg("区分（高校・中学校など）を選択してください"); return; }
    try {
      await updateSchoolMaster(id, { name: editName.trim(), prefecture: editPrefecture.trim() || null, category: editCategory, gender_restriction: editGenderRestriction });
      setEditingId(null);
      reload();
    } catch (e) {
      setErrorMsg(e.message?.includes("duplicate") ? "同じ名前・同じ区分の学校がすでに登録されています" : (e.message || "更新に失敗しました"));
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("この学校をマスターから削除しますか？")) return;
    setErrorMsg("");
    try {
      await deleteSchoolMaster(id);
      reload();
    } catch (e) {
      setErrorMsg(
        (e.message?.includes("foreign key") || e.code === "23503")
          ? "この学校を選択しているメンバーがいるため削除できません。先にメンバーに別の学校を選び直してもらうか、学校名を編集してください。"
          : (e.message || "削除に失敗しました")
      );
    }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>学校マスター管理</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:"#f5f5f5",border:"1px solid #e0e0e0",borderRadius:10,padding:"10px 14px",fontSize:12,color:C.textSec,marginBottom:14 }}>
          ℹ️ ここで登録した学校だけが、新規登録・プロフィールの学校名選択肢に表示されます。同じ学校名でも区分（高校・中学校など）が違えば別の学校として登録できます。
        </div>

        <FormSec title="学校を追加">
          <FormRow label="学校名">
            <input style={S.inp} placeholder="例：東福岡" value={newName} onChange={e=>setNewName(e.target.value)} />
          </FormRow>
          <FormRow label="区分">
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {CATEGORY_OPTIONS.map(c => (
                <button key={c.key} style={S.togBtn(newCategory===c.key)} onClick={()=>setNewCategory(c.key)}>{c.label}</button>
              ))}
            </div>
          </FormRow>
          <FormRow label="都道府県（任意）">
            <select style={{ ...S.inp, background:"transparent" }} value={newPrefecture} onChange={e=>setNewPrefecture(e.target.value)}>
              <option value="">指定なし</option>
              {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FormRow>
          <FormRow label="男女の制限">
            <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
              {GENDER_RESTRICTION_OPTIONS.map(g => (
                <button key={g.key} style={S.togBtn(newGenderRestriction===g.key)} onClick={()=>setNewGenderRestriction(g.key)}>{g.label}</button>
              ))}
            </div>
          </FormRow>
        </FormSec>

        {errorMsg && <div style={{ color:C.red,fontSize:12,marginBottom:10 }}>{errorMsg}</div>}

        <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:16 }} onClick={handleAdd}>＋ 追加する</button>

        {loading && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>読み込み中...</div>}
        {!loading && schools.length===0 && <div style={{ textAlign:"center",color:C.textSec,padding:"20px 0" }}>登録されている学校がありません</div>}

        {!loading && schools.length>0 && (
          <select
            style={{ ...S.inp, background:"transparent", marginBottom:10 }}
            value={listPrefFilter}
            onChange={e=>setListPrefFilter(e.target.value)}
          >
            <option value="">都道府県で絞り込み（すべて表示）</option>
            {Array.from(new Set(schools.map(s=>s.prefecture).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"ja")).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}

        {schools.filter(s => !listPrefFilter || s.prefecture === listPrefFilter).map(s => (
          <div key={s.id} style={S.card}>
            {editingId===s.id ? (
              <div style={{ padding:12 }}>
                <input style={{ ...S.inp, marginBottom:8 }} value={editName} onChange={e=>setEditName(e.target.value)} />
                <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:10 }}>
                  {CATEGORY_OPTIONS.map(c => (
                    <button key={c.key} style={S.togBtn(editCategory===c.key)} onClick={()=>setEditCategory(c.key)}>{c.label}</button>
                  ))}
                </div>
                <select style={{ ...S.inp, background:"transparent", marginBottom:10 }} value={editPrefecture} onChange={e=>setEditPrefecture(e.target.value)}>
                  <option value="">指定なし</option>
                  {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:10 }}>
                  {GENDER_RESTRICTION_OPTIONS.map(g => (
                    <button key={g.key} style={S.togBtn(editGenderRestriction===g.key)} onClick={()=>setEditGenderRestriction(g.key)}>{g.label}</button>
                  ))}
                </div>
                {errorMsg && <div style={{ color:C.red,fontSize:12,marginBottom:8,padding:"6px 8px",background:"#fdecea",borderRadius:6 }}>{errorMsg}</div>}
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                  <button style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:12 }} onClick={()=>{setEditingId(null);setErrorMsg("");}}>キャンセル</button>
                  <button style={{ ...S.btn(C.accent),fontSize:12 }} onClick={()=>handleUpdate(s.id)}>保存</button>
                </div>
              </div>
            ) : (
              <div style={{ display:"flex",alignItems:"center",padding:"12px 14px",gap:10 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14,fontWeight:700,color:C.text }}>{s.name}</div>
                  <div style={{ fontSize:11,color:C.textSec }}>
                    {[categoryLabel(s.category) || "区分未設定", s.prefecture, genderRestrictionLabel(s.gender_restriction)].filter(Boolean).join("・")}
                  </div>
                </div>
                <button style={{ background:"none",border:"none",fontSize:16,cursor:"pointer" }} onClick={()=>{ setEditingId(s.id); setEditName(s.name); setEditPrefecture(s.prefecture||""); setEditCategory(s.category||null); setEditGenderRestriction(s.gender_restriction||"mixed"); }}>✏️</button>
                <button style={{ background:"none",border:"none",fontSize:16,cursor:"pointer",color:C.red }} onClick={()=>handleDelete(s.id)}>🗑</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// ログイン／新規登録画面
// ============================================================
function translateAuthError(msg) {
  if (!msg) return "登録に失敗しました";
  if (msg.includes("User already registered") || msg.includes("already been registered")) return "このメールアドレスはすでに登録されています。ログインしてください。";
  if (msg.includes("Email rate limit exceeded") || msg.includes("email rate limit")) return "短時間に何度も登録しようとしています。しばらく待ってから再試行してください。";
  if (msg.includes("Invalid email")) return "メールアドレスの形式が正しくありません。";
  if (msg.includes("Password should be")) return "パスワードは6文字以上で入力してください。";
  if (msg.includes("signup is disabled")) return "現在新規登録は無効になっています。管理者にお問い合わせください。";
  if (msg.includes("network") || msg.includes("fetch")) return "通信エラーが発生しました。インターネット接続を確認してください。";
  if (msg.includes("duplicate") || msg.includes("unique")) return "すでに登録済みのデータと重複しています。";
  return "登録に失敗しました（" + msg + "）";
}

// ★新規登録時のusersテーブル保存＋選手マスター連携をまとめた共通処理。
// メール確認が必須の設定だと、登録直後はまだセッションがなく保存に失敗するため、
// その場合は一時保存しておき、確認メール経由で初めてログインできた時にこの関数を呼んで自動で仕上げる。
//
// ★品質改善メモ：
// ・選手を探す際は「名前が同じ」だけでなく「学校IDも同じ」かどうかを見て、
//   同姓同名の別選手に誤ってリンクしてしまわないようにしている。
// ・users テーブルの update() は結果(error)を必ず確認し、失敗時ははっきり例外を投げる
//   （黙って0件更新のまま処理が続いてしまうのを防ぐ）。
// ・複数ステップ（プロフィール保存→選手検索→選手作成→ユーザー更新）はDBトランザクションではないため、
//   途中で失敗すると一部だけ保存された状態になり得る。どのステップで失敗したかを例外メッセージに
//   含めることで、少なくとも原因調査と手動リカバリはしやすくしている。
//   （将来的にはSupabaseのRPC/Postgres関数にまとめ、DB側で1トランザクションにするのが望ましい）
async function completeProfileRegistration(userId, payload) {
  // ★school_name の取得やNOT NULL対応、エラー処理などを二重に持たず、
  // 必ず saveMyProfile を通すことで保存ロジックを一本化する（今回のような食い違いバグの再発防止）
  try {
    await saveMyProfile({
      name: payload.fullName,
      school_id: payload.schoolId,
      prefecture: payload.prefecture,
      gender_category: payload.genderCategory,
      category: payload.category,
      is_approved: true,
    });
  } catch(e) {
    throw new Error("プロフィール保存に失敗しました: " + (e.message || e));
  }

  async function linkOrCreatePlayer(playerName, position, hand) {
    let roster;
    try {
      roster = await getPlayerRoster();
    } catch(e) {
      throw new Error("選手検索に失敗しました: " + (e.message || e));
    }
    // 同姓同名でも別の学校の選手を誤ってリンクしないよう、学校IDも条件に含める
    const existing = roster.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(playerName) && p.is_own_team && p.school_id === payload.schoolId);
    let linkedId = existing?.id;
    if (!existing) {
      try {
        await savePlayer({ player_name: playerName, position, dominant_hand: hand, is_own_team: true, school_id: payload.schoolId });
      } catch(e) {
        throw new Error("選手の新規作成に失敗しました: " + (e.message || e));
      }
      let refreshed;
      try {
        refreshed = await getPlayerRoster();
      } catch(e) {
        throw new Error("作成した選手の再取得に失敗しました: " + (e.message || e));
      }
      const saved = refreshed.find(p => normalizePlayerName(p.player_name) === normalizePlayerName(playerName) && p.is_own_team && p.school_id === payload.schoolId);
      linkedId = saved?.id;
    }
    if (linkedId) {
      const { error } = await supabase.from("users").update({ linked_player_id: linkedId }).eq("id", userId);
      if (error) throw new Error("ユーザーと選手の紐づけに失敗しました: " + error.message);
    }
  }

  if (payload.registerMode === "player") {
    await linkOrCreatePlayer(payload.fullName, payload.playerPosition, payload.playerHand);
  }

  if (payload.registerMode === "guardian" && payload.childName) {
    await linkOrCreatePlayer(payload.childName, payload.childPosition, payload.childHand);
  }
}

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [lastName,     setLastName]     = useState("");
  const [firstName,    setFirstName]    = useState("");
  const [schoolId,    setSchoolId]    = useState(null);
  const [prefecture,  setPrefecture]  = useState("東京都");
  const [genderCategory, setGenderCategory] = useState(null);
  const [category,    setCategory]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [schools, setSchools] = useState([]);
  const [schoolPrefFilter, setSchoolPrefFilter] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  // 登録区分: null=未選択, "player"=選手, "guardian"=保護者
  const [registerMode, setRegisterMode] = useState(null);
  const [playerPosition, setPlayerPosition] = useState(null);
  const [playerHand, setPlayerHand] = useState(null);
  // 保護者：直接入力用
  const [childLastName, setChildLastName] = useState("");
  const [childFirstName, setChildFirstName] = useState("");
  const [childMode, setChildMode] = useState("select"); // select | input
  const [childPosition, setChildPosition] = useState(null);
  const [childHand, setChildHand] = useState(null);

  useEffect(() => { getSchools().then(setSchools); }, []);

  async function handleLogin() {
    setErrorMsg("");
    if (!email.trim()) { setErrorMsg("メールアドレスを入力してください"); return; }
    if (password.length < 6) { setErrorMsg("パスワードは6文字以上で入力してください"); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      onAuthed();
    } catch (e) {
      setErrorMsg(e.message === "Invalid login credentials" ? "メールアドレスまたはパスワードが違います" : translateAuthError(e.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup() {
    setErrorMsg("");
    const fullName = [lastName.trim(), firstName.trim()].filter(Boolean).join(" ");
    if (!email.trim()) { setErrorMsg("メールアドレスを入力してください"); return; }
    if (password.length < 6) { setErrorMsg("パスワードは6文字以上で入力してください"); return; }
    if (!fullName) { setErrorMsg("お名前（姓）を入力してください"); return; }
    if (!schoolId) { setErrorMsg("学校名を選択してください"); return; }
    if (!genderCategory) { setErrorMsg("男子・女子・共通を選択してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    if (!inviteInput.trim()) { setErrorMsg("招待コードを入力してください"); return; }

    const codeOk = await verifyInviteCode(schoolId, inviteInput);
    if (!codeOk) { setErrorMsg("招待コードが正しくありません。管理者に確認してください。"); return; }

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) throw error;
      if (data.user) {
        const payload = {
          fullName, schoolId, prefecture, genderCategory, category, registerMode,
          playerPosition, playerHand,
          childName: [childLastName.trim(), childFirstName.trim()].filter(Boolean).join(" "),
          childPosition, childHand,
        };
        if (data.session) {
          // メール確認不要 or 即セッション確立 → その場で登録を完了させる
          await completeProfileRegistration(data.user.id, payload);
        } else {
          // メール確認が必須の設定 → 今は保存できないので一時保存し、確認後の初回ログイン時に自動で仕上げる
          try { localStorage.setItem("pendingProfile_"+email.trim(), JSON.stringify(payload)); } catch(e){}
          setLoading(false);
          alert("確認メールを送信しました。メール内のリンクをタップしてから、このアプリにログインしてください。選手情報は自動で登録されます。");
          return;
        }
      }
      onAuthed();
    } catch (e) {
      setErrorMsg(translateAuthError(e.message) || "登録に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ ...S.page, display:"flex", flexDirection:"column", justifyContent:"center", padding:"24px 20px" }}>
      <div style={{ textAlign:"center", marginBottom:28 }}>
        <div style={{ fontSize:44, marginBottom:8 }}>🎾</div>
        <div style={{ fontSize:20, fontWeight:800, color:C.navy }}>ソフトテニス記録アプリ</div>
        <div style={{ fontSize:12, color:C.textSec, marginTop:4 }}>スコア記録・データ分析</div>
      </div>

      {/* タブ切替 */}
      <div style={{ display:"flex", background:"#f0f2f6", padding:3, borderRadius:10, marginBottom:18 }}>
        {[["login","ログイン"],["signup","新規登録"]].map(([v,l]) => (
          <button key={v} style={{ flex:1, padding:9, border:"none", cursor:"pointer", borderRadius:8, fontSize:13, fontWeight:700, background:mode===v?C.white:"transparent", color:mode===v?C.navy:C.textSec, boxShadow:mode===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>{ setMode(v); setErrorMsg(""); }}>{l}</button>
        ))}
      </div>

      <div style={S.card}>
        <div style={{ padding:"14px 16px" }}>
          <label style={S.lbl}>メールアドレス</label>
          <input type="email" style={S.inp} placeholder="example@email.com" value={email} onChange={e=>setEmail(e.target.value)} autoCapitalize="none"/>
        </div>
        <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
          <label style={S.lbl}>パスワード（6文字以上）</label>
          <input type="password" style={S.inp} placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)}/>
        </div>

        {mode==="signup" && (
          <>
            {/* 姓・名 */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>お名前</label>
              <div style={{ display:"flex", gap:10 }}>
                <input style={{ ...S.inp, flex:1 }} placeholder="姓（名字）" value={lastName} onChange={e=>setLastName(e.target.value)}/>
                <input style={{ ...S.inp, flex:1 }} placeholder="名（任意）" value={firstName} onChange={e=>setFirstName(e.target.value)}/>
              </div>
              <div style={{ fontSize:11, color:"#aaa", marginTop:4 }}>💡 姓だけでも登録できます</div>
            </div>

            {/* 都道府県（学校リストと連動） */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>都道府県</label>
              <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>{ setPrefecture(e.target.value); setSchoolPrefFilter(e.target.value); setSchoolId(null); }}>
                {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            {/* 男女区分 */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>チーム区分</label>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {GENDER_OPTIONS.map(g => (
                  <button key={g.key} style={S.togBtn(genderCategory===g.key)} onClick={()=>setGenderCategory(g.key)}>{g.label}</button>
                ))}
              </div>
            </div>

            {/* 区分 */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>世代区分</label>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {CATEGORY_OPTIONS.map(c => (
                  <button key={c.key} style={S.togBtn(category===c.key)} onClick={()=>setCategory(c.key)}>{c.label}</button>
                ))}
              </div>
            </div>

            {/* 学校名（都道府県・男女・区分連動） */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>学校名またはチーム名</label>
              <SchoolIdSelect value={schoolId} onChange={setSchoolId} schools={schools} prefFilter={schoolPrefFilter} genderCategory={genderCategory} />
            </div>

            {/* 招待コード */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>招待コード</label>
              <input
                style={{ ...S.inp, textAlign:"center", fontSize:18, fontWeight:800, letterSpacing:6 }}
                placeholder=""
                value={inviteInput}
                maxLength={6}
                onChange={e=>setInviteInput(e.target.value.toUpperCase())}
              />
              <div style={{ fontSize:11, color:C.textSec, marginTop:4 }}>チームの管理者から招待コードを受け取り入力してください。</div>
            </div>

            {/* 登録区分 2ブロック */}
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                <label style={S.lbl}>選手登録</label>
                {registerMode && (
                  <button style={{ fontSize:12, color:C.textSec, background:"none", border:"none", cursor:"pointer", textDecoration:"underline" }} onClick={()=>setRegisterMode(null)}>選択をリセット</button>
                )}
              </div>

              {/* ブロックA: 選手 */}
              <div
                onClick={()=>{ if(registerMode!=="player") setRegisterMode("player"); }}
                style={{ border:`1.5px solid ${registerMode==="player" ? C.navy : C.border}`, borderRadius:10, marginBottom:8, overflow:"hidden", cursor:"pointer", opacity:registerMode==="guardian"?0.4:1, pointerEvents:registerMode==="guardian"?"none":"auto", transition:"opacity 0.2s" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:registerMode==="player"?"#eef1f8":"#fafafa" }}>
                  <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${registerMode==="player"?C.navy:"#ccc"}`, background:registerMode==="player"?C.navy:"white", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {registerMode==="player" && <div style={{ width:8, height:8, borderRadius:"50%", background:"white" }} />}
                  </div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>🎾 選手として登録する</div>
                    <div style={{ fontSize:11, color:C.textSec, marginTop:2 }}>自分自身が選手です（部員・選手本人）</div>
                  </div>
                </div>
                {registerMode==="player" && (
                  <div style={{ padding:"12px 14px", borderTop:`1px solid ${C.border}` }} onClick={e=>e.stopPropagation()}>
                    <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>ポジション（任意）</div>
                    <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                      {["前衛","後衛"].map(v => <button key={v} style={S.togBtn(playerPosition===v)} onClick={()=>setPlayerPosition(playerPosition===v?null:v)}>{v}</button>)}
                    </div>
                    <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>利き手（任意）</div>
                    <div style={{ display:"flex", gap:8 }}>
                      {["右","左"].map(v => <button key={v} style={S.togBtn(playerHand===v)} onClick={()=>setPlayerHand(playerHand===v?null:v)}>{v}</button>)}
                    </div>
                  </div>
                )}
              </div>

              {/* ブロックB: 保護者 */}
              <div
                onClick={()=>{ if(registerMode!=="guardian") setRegisterMode("guardian"); }}
                style={{ border:`1.5px solid ${registerMode==="guardian"?C.navy:C.border}`, borderRadius:10, overflow:"hidden", cursor:"pointer", opacity:registerMode==="player"?0.4:1, pointerEvents:registerMode==="player"?"none":"auto", transition:"opacity 0.2s" }}
              >
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:registerMode==="guardian"?"#eef1f8":"#fafafa" }}>
                  <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${registerMode==="guardian"?C.navy:"#ccc"}`, background:registerMode==="guardian"?C.navy:"white", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {registerMode==="guardian" && <div style={{ width:8, height:8, borderRadius:"50%", background:"white" }} />}
                  </div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>👤 保護者・関係者として登録する</div>
                    <div style={{ fontSize:11, color:C.textSec, marginTop:2 }}>お子さんや関連選手の戦績を確認したい方</div>
                  </div>
                </div>
                {registerMode==="guardian" && (
                  <div style={{ padding:"12px 14px", borderTop:`1px solid ${C.border}` }} onClick={e=>e.stopPropagation()}>
                    <div style={{ fontSize:12, color:C.textSec, marginBottom:10 }}>お子さん／関連選手を登録します（任意）</div>
                    <div style={{ display:"flex", gap:10, marginBottom:4 }}>
                      <input style={{ ...S.inp, flex:1 }} placeholder="姓（名字）" value={childLastName} onChange={e=>setChildLastName(e.target.value)} onClick={e=>e.stopPropagation()}/>
                      <input style={{ ...S.inp, flex:1 }} placeholder="名（任意）" value={childFirstName} onChange={e=>setChildFirstName(e.target.value)} onClick={e=>e.stopPropagation()}/>
                    </div>
                    <div style={{ fontSize:11, color:"#aaa", marginBottom:10 }}>💡 姓だけでも登録できます</div>
                    <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>ポジション（任意）</div>
                    <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                      {["前衛","後衛"].map(v => <button key={v} style={S.togBtn(childPosition===v)} onClick={e=>{ e.stopPropagation(); setChildPosition(childPosition===v?null:v); }}>{v}</button>)}
                    </div>
                    <div style={{ fontSize:12, color:C.textSec, marginBottom:8 }}>利き手（任意）</div>
                    <div style={{ display:"flex", gap:8 }}>
                      {["右","左"].map(v => <button key={v} style={S.togBtn(childHand===v)} onClick={e=>{ e.stopPropagation(); setChildHand(childHand===v?null:v); }}>{v}</button>)}
                    </div>
                    <div style={{ fontSize:11, color:C.textSec, marginTop:10 }}>※ 入力しなくても登録後にプロフィール画面から選手を選択できます。</div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {errorMsg && (
        <div style={{ background:C.redL, color:C.red, fontSize:12, padding:"10px 14px", borderRadius:10, marginTop:12, fontWeight:700 }}>
          ⚠️ {errorMsg}
        </div>
      )}

      <button
        style={{ ...S.btn(mode==="login" ? `linear-gradient(135deg,${C.accent},#00a066)` : C.navy), marginTop:16, opacity:loading?0.6:1 }}
        disabled={loading}
        onClick={mode==="login" ? handleLogin : handleSignup}
      >
        {loading ? "処理中..." : (mode==="login" ? "ログイン" : "新規登録する")}
      </button>
    </div>
  );
}

export default function App() {
  // ★連打時にブラウザの「ダブルタップズーム」や「テキスト選択（Google検索バー）」が
  //   誤発動してボタンが反応しなくなる不具合対策。フォーム入力欄以外は選択不可にし、
  //   タップの二重解釈を防ぐ（touch-action:manipulation）。
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      html, body, #root {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      input, textarea {
        -webkit-user-select: text;
        user-select: text;
        touch-action: auto;
      }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  // ログイン状態の確認
  const [authChecked, setAuthChecked] = useState(false);
  const [user,        setUser]        = useState(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const [screen,       setScreen]       = useState("home");
  const [prevScreen,   setPrevScreen]   = useState("list"); // 戻るボタン用
  const [initMatchType, setInitMatchType] = useState(null); // フィルター連動用

  // ★画面が切り替わるたびに、前の画面のスクロール位置が残らないよう先頭に戻す
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

  // ★動画レビュー画面の状態はここ（App本体）に持たせ、他のタブに移動して戻っても消えないようにする
  const [vrMatchId, setVrMatchId] = useState(null);
  const [vrStep, setVrStep] = useState("setup");
  const [vrPickedFile, setVrPickedFile] = useState(null);
  const [vrVideoObjectUrl, setVrVideoObjectUrl] = useState(null);
  const [listFilter,   setListFilter]   = useState("all"); // 試合一覧フィルター
  const [toast, setToast] = useState(null); // トースト通知
  const [matchId,      setMatchId]      = useState(null);
  const [copySourceId, setCopySourceId] = useState(null); // コピー元の試合ID
  const [editTargetId, setEditTargetId] = useState(null); // 編集対象の試合ID
  const [tick,         setTick]         = useState(0);
  const [statsPlayerName,   setStatsPlayerName]   = useState(null); // 直接開く選手名（統計画面から遷移時）
  const [statsOpponentName, setStatsOpponentName] = useState(null); // 直接開く対戦相手校名
  const [playerStatsFrom,   setPlayerStatsFrom]   = useState("home"); // 選手戦績画面の戻り先（home/stats）
  // 団体戦関連
  const [teamMatchId,  setTeamMatchId]  = useState(null);
  const [teamMatchEditId, setTeamMatchEditId] = useState(null);
  const [teamMatchOrderNum, setTeamMatchOrderNum] = useState(null);
  const [teamMatchCopyId, setTeamMatchCopyId] = useState(null); // コピー元の団体戦ID
  const [listMatchMode, setListMatchMode] = useState("tournament");
  const [pendingOpenTrash, setPendingOpenTrash] = useState(false); // ★設定画面からゴミ箱を開く指示
  const [serveSelectForTeam, setServeSelectForTeam] = useState(null); // 団体戦サーブ選択 // 履歴画面のタブ状態
  // 大会関連
  const [tournamentContext, setTournamentContext] = useState(null); // 大会詳細画面から試合作成に入った際の大会情報 {id,name,start_date,end_date}
  const [creatingFromTournament, setCreatingFromTournament] = useState(false); // 大会の＋ボタンから試合作成に入ったかどうか
  const [tournamentSeg, setTournamentSeg] = useState("team"); // 大会詳細画面のタブ（team/individual）を試合詳細から戻った時も維持する

  // ★大会詳細から試合を開いた後に「戻る」を押したとき、途中でアプリが再読み込みされていても
  //   元の大会・タブに戻れるよう、tournamentContext/tournamentSegをsessionStorageにも控えておく。
  useEffect(() => {
    try {
      if (tournamentContext) {
        sessionStorage.setItem("tournamentReturnCtx", JSON.stringify({ tournamentContext, tournamentSeg }));
      }
    } catch (e) {}
  }, [tournamentContext, tournamentSeg]);
  const restoreTournamentReturnCtx = () => {
    try {
      const raw = sessionStorage.getItem("tournamentReturnCtx");
      if (!raw) return false;
      const { tournamentContext: tc, tournamentSeg: seg } = JSON.parse(raw);
      if (tc) { setTournamentContext(tc); if (seg) setTournamentSeg(seg); return true; }
    } catch (e) {}
    return false;
  };

  // 大会に紐づく試合を新規作成する際のデフォルト試合日
  // 今日が大会期間内ならその日を、期間外なら大会の初日を使う
  const smartTournamentDate = (t) => {
    if (!t) return undefined;
    const todayStr = today();
    return (todayStr >= t.start_date && todayStr <= t.end_date) ? todayStr : t.start_date;
  };

  // 大会詳細を経由しているときは、戻る先を「一覧」ではなく「大会詳細」にする
  const backToListOrTournament = () => { setScreen(tournamentContext ? "tournamentDetail" : "list"); };

  // ★試合を「開く」時に、それが団体戦の1番手かどうかを判定して正しい画面へ振り分ける。
  //   これを通さずに一律 screen="record" にすると、団体戦の記録者ロック（recorder_id）判定がずれて
  //   本来の記録者なのに観戦モード（閲覧のみ）になってしまう不具合が起きる。
  async function openMatchSmart(id, { prevScreen: ps, listMatchMode: lmm } = {}) {
    const { data: tmg } = await supabase.from("team_match_games").select("team_match_id, order_num").eq("match_id", id).maybeSingle();
    if (tmg) {
      setTeamMatchId(tmg.team_match_id);
      setTeamMatchOrderNum(tmg.order_num);
      setMatchId(id);
      setTick(t=>t+1);
      setScreen("teamMatchRecord");
    } else {
      setMatchId(id);
      if (ps) setPrevScreen(ps);
      if (lmm) setListMatchMode(lmm);
      setScreen("record");
    }
  }


  // 自動ping：24時間ごとにDBへアクセスしてSupabaseの自動停止を防ぐ
  useEffect(() => {
    const ping = () => supabase.from("schools").select("id").limit(1);
    ping();
    const interval = setInterval(ping, 1000 * 60 * 60 * 24);
    return () => clearInterval(interval);
  }, []);
  // ② ブラウザを閉じる・リロード時に確認ダイアログを表示
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "アプリを終了しますか？";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // プロフィール（学校・男女区分が未設定だと試合・選手マスターを共有できないため、設定完了をチェック）
  const [profile, setProfile] = useState(null);
  const [profileChecked, setProfileChecked] = useState(false);
  useEffect(() => {
    if (!user) { setProfileChecked(false); return; }
    let cancelled = false;
    setProfileChecked(false);
    getMyProfile().then(p => {
      if (cancelled) return;
      // ★一時的な取得失敗等でnullが返ってきても、既に読み込み済みの正常なプロフィールは保持する
      //   （これが原因でプロフィール未完了と誤判定され、強制的にプロフィール画面へ飛ばされていた）
      if (p) setProfile(p);
      setProfileChecked(true);
    });
    return () => { cancelled = true; };
    // ★user?.id のみを依存にする：Supabaseはタブ復帰時などトークン更新のたびに
    //   session.user を「同じユーザーだが新しいオブジェクト」として発火することがあり、
    //   [user]全体を依存にしていると同一ユーザーのままここが毎回再実行され、
    //   その一瞬の「読み込み中」画面で入力中の画面が丸ごと作り直されて
    //   入力内容が消えてしまっていた（団体戦フォーム等）。ユーザーIDが変わった時だけ再取得する。
  }, [user?.id]);

  // ★メール確認が必須の設定で登録直後に保存できなかった場合、確認後の初回ログイン時に
  //   一時保存しておいた選手情報を自動で登録完了させる（お子さんが再入力しなくて済むように）
  const [pendingApplied, setPendingApplied] = useState(false);
  useEffect(() => { setPendingApplied(false); }, [user?.id]);
  useEffect(() => {
    if (!user || !profileChecked || pendingApplied) return;
    const incomplete = !profile || !profile.school_id || !profile.gender_category;
    if (!incomplete) { setPendingApplied(true); return; }
    const key = "pendingProfile_" + (user.email || "");
    let raw = null;
    try { raw = localStorage.getItem(key); } catch(e){}
    if (!raw) { setPendingApplied(true); return; }
    (async () => {
      try {
        const payload = JSON.parse(raw);
        await completeProfileRegistration(user.id, payload);
        try { localStorage.removeItem(key); } catch(e){}
        const p = await getMyProfile();
        setProfile(p);
      } catch(e) {
        console.error("保留中の選手情報の自動登録に失敗しました", e);
      } finally {
        setPendingApplied(true);
      }
    })();
  }, [user, profileChecked, profile, pendingApplied]);

  // ログイン状態確認中は簡易ローディング表示
  if (!authChecked) {
    return (
      <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ textAlign:"center", color:C.textSec }}>
          <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
          読み込み中...
        </div>
      </div>
    );
  }

  // 未ログインならログイン画面へ
  if (!user) {
    return <AuthScreen onAuthed={()=>{}} />;
  }

  // プロフィール確認中、または保留中データの自動適用中は簡易ローディング表示
  if (!profileChecked || !pendingApplied) {
    return (
      <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ textAlign:"center", color:C.textSec }}>
          <div style={{ fontSize:36, marginBottom:8 }}>🎾</div>
          読み込み中...
        </div>
      </div>
    );
  }

  // 学校・男女区分が未設定の場合は、設定が終わるまでプロフィール画面に固定する
  // （未設定のままだと試合・選手マスターの共有判定ができないため）
  const profileIncomplete = !profile || !profile.school_id || !profile.gender_category;
  if (profileIncomplete) {
    return (
      <ProfileScreen
        forced
        onBack={()=>{ getMyProfile().then(p=>{ setProfile(p); setScreen("list"); }); }}
        onSaved={()=>{ getMyProfile().then(setProfile); }}
      />
    );
  }

  if (screen==="profile") {
    return <ProfileScreen onBack={()=>setScreen("home")} onSaved={()=>{ getMyProfile().then(setProfile); }} />;
  }
  if (screen==="roster") {
    return <PlayerRosterScreen onBack={()=>setScreen("master")} />;
  }
  if (screen==="schoolAdmin") {
    return <AdminSchoolsScreen onBack={()=>setScreen("master")} />;
  }
  if (screen==="playerStats") {
    return (
      <PlayerStatsScreen
        onBack={()=>{ setStatsPlayerName(null); setScreen(playerStatsFrom); }}
        onOpen={id=>openMatchSmart(id, { prevScreen:"home" })}
        initialPlayerName={statsPlayerName}
      />
    );
  }
  if (screen==="opponentStats") {
    return (
      <OpponentStatsScreen
        schoolName={statsOpponentName}
        onBack={()=>{ setStatsOpponentName(null); setScreen("stats"); }}
        onOpen={id=>openMatchSmart(id)}
      />
    );
  }

  // 団体戦画面
  if (screen==="teamMatchSetup") {
    return (
      <TeamMatchSetup
        editId={teamMatchEditId}
        copyId={teamMatchCopyId}
        prefillTournament={creatingFromTournament && tournamentContext ? tournamentContext.name : undefined}
        prefillDate={creatingFromTournament && tournamentContext ? smartTournamentDate(tournamentContext) : undefined}
        prefillVenue={creatingFromTournament && tournamentContext ? tournamentContext.venue : undefined}
        lockTournament={creatingFromTournament && !!tournamentContext}
        tournamentStartDate={creatingFromTournament && tournamentContext ? tournamentContext.start_date : undefined}
        tournamentEndDate={creatingFromTournament && tournamentContext ? tournamentContext.end_date : undefined}
        onSave={id=>{ setTeamMatchId(id); setTeamMatchEditId(null); setTeamMatchCopyId(null); setCreatingFromTournament(false); setScreen("teamMatchDetail"); }}
        onCancel={()=>{ setTeamMatchEditId(null); setTeamMatchCopyId(null); setCreatingFromTournament(false); setListMatchMode("team"); backToListOrTournament(); }}
      />
    );
  }
  if (screen==="teamMatchDetail" && teamMatchId) {
    return (
      <TeamMatchDetail
        teamMatchId={teamMatchId}
        onBack={()=>{ setTeamMatchId(null); setListMatchMode("team"); backToListOrTournament(); }}
        onOpenMatch={id=>{ setMatchId(id); setTeamMatchOrderNum(null); setTick(t=>t+1); setScreen("teamMatchRecord"); }}
        onNewMatch={async (tm, orderNum, existingGame)=>{
          setTeamMatchOrderNum(orderNum);
          setCopySourceId(null);
          setEditTargetId(null);
          setInitMatchType("tournament");
          setPrevScreen("teamMatchDetail");
          setScreen("teamMatchGameSetup");
        }}
        onStartMatch={async (matchId, orderNum, existingGame, firstServer)=>{
          // サーブ選択済み → 試合開始
          const { data:{ user } } = await supabase.auth.getUser();
          const profile = await getMyProfile();
          await startScheduledMatch(matchId, firstServer);
          await updateTeamMatchGame(existingGame.id, { status:"active", recorder_id: user?.id, recorder_name: profile?.name || "" });
          await supabase.from("team_matches").update({ status:"active" }).eq("id", teamMatchId).eq("status","scheduled");
          setMatchId(matchId);
          setTeamMatchOrderNum(orderNum);
          setTick(t=>t+1);
          setScreen("teamMatchRecord");
        }}
        onEdit={id=>{ setTeamMatchEditId(id); setScreen("teamMatchSetup"); }}
        onNavigate={key=>{ setTeamMatchId(null); goNav(key); }}
      />
    );
  }

  if (screen==="teamMatchGameSetup") {
    return (
      <TeamMatchGameSetupWrapper
        teamMatchId={teamMatchId}
        orderNum={teamMatchOrderNum}
        onSave={async (matchId)=>{
          const { data: { user } } = await supabase.auth.getUser();
          const profile = await getMyProfile();
          const existingGame = (await getTeamMatch(teamMatchId))?.games?.find(g=>g.order_num===teamMatchOrderNum);
          if (existingGame) {
            await updateTeamMatchGame(existingGame.id, { match_id: matchId, status:"active", recorder_id: user?.id, recorder_name: profile?.name || "" });
          } else {
            await saveTeamMatchGame({ team_match_id: teamMatchId, order_num: teamMatchOrderNum, match_id: matchId, status:"active", recorder_id: user?.id, recorder_name: profile?.name || "" });
          }
          await supabase.from("team_matches").update({ status:"active" }).eq("id", teamMatchId).eq("status","scheduled");
          setMatchId(matchId);
          setTick(t=>t+1);
          setScreen("teamMatchRecord");
        }}
        onSavePairOnly={async (matchId, pairInfo)=>{
          // ペアのみ登録してteamMatchDetailへ戻る（試合開始しない）
          const { data: { user } } = await supabase.auth.getUser();
          const existingGame = (await getTeamMatch(teamMatchId))?.games?.find(g=>g.order_num===teamMatchOrderNum);
          if (existingGame) {
            await updateTeamMatchGame(existingGame.id, { match_id: matchId, status:"waiting", recorder_id: null, recorder_name: null });
          } else {
            await saveTeamMatchGame({ team_match_id: teamMatchId, order_num: teamMatchOrderNum, match_id: matchId, status:"waiting", recorder_id: null, recorder_name: null });
          }
          setListMatchMode("team");
          setTick(t=>t+1);
          setTimeout(()=>setScreen("teamMatchDetail"), 50);
        }}
        onCancel={()=>{ setListMatchMode("team"); setScreen("teamMatchDetail"); }}
      />
    );
  }
  if (screen==="teamMatchRecord" && matchId && teamMatchId) {
    return (
      <ScoreRecord
        key={matchId+tick}
        matchId={matchId}
        teamMatchId={teamMatchId}
        orderNum={teamMatchOrderNum}
        onBack={()=>{ setTeamMatchOrderNum(null); setMatchId(null); setScreen("teamMatchDetail"); }}
        onEdit={id=>{ setEditTargetId(id); setPrevScreen("teamMatchRecord"); setScreen("setup"); }}
        onNavigate={key=>{ recalcTeamMatchScore(teamMatchId); setTick(t=>t+1); setMatchId(null); goNav(key); }}
      />
    );
  }

  // ★下部ナビゲーション（ホーム/履歴/分析/マスター）の共通遷移ハンドラ
  function goNav(key) {
    // 現在表示中の画面と同じタブを押しても何もしない
    const screenMap = { home:"home", list:"list", video:"video", stats:"personalAnalysis", master:"master" };
    if (screen === screenMap[key]) return;
    setTournamentContext(null); // ボトムナビでの移動時は大会の文脈から抜ける
    if (key==="home") setScreen("home");
    else if (key==="list") setScreen("list");
    else if (key==="video") setScreen("video");
    else if (key==="stats") setScreen("personalAnalysis");
    else if (key==="master") setScreen("master");
  }

  if (screen==="home") {
    return (
      <HomeScreen
        onNew={()=>{ setTournamentContext(null); setCopySourceId(null); setEditTargetId(null); setInitMatchType(null); setPrevScreen("home"); setScreen("setup"); }}
        onNewTeamMatch={()=>{ setTournamentContext(null); setTeamMatchEditId(null); setScreen("teamMatchSetup"); }}
        onOpen={id=>openMatchSmart(id)}
        onNavigate={goNav}
        onGoPlayerStats={()=>{ setStatsPlayerName(null); setPlayerStatsFrom("home"); setScreen("playerStats"); }}
        onProfile={()=>setScreen("profile")}
        onGoToTournaments={()=>{ setTournamentContext(null); setListMatchMode("tournament"); setScreen("list"); }}
        onOpenTournament={t=>{ setTournamentContext(t); setListMatchMode("tournament"); setScreen("tournamentDetail"); }}
      />
    );
  }
  if (screen==="video") {
    return <VideoReviewScreen onNavigate={goNav}
      matchId={vrMatchId} setMatchId={setVrMatchId}
      step={vrStep} setStep={setVrStep}
      pickedFile={vrPickedFile} setPickedFile={setVrPickedFile}
      videoObjectUrl={vrVideoObjectUrl} setVideoObjectUrl={setVrVideoObjectUrl}
    />;
  }
  if (screen==="master") {
    return (
      <MasterScreen
        onNavigate={goNav}
        onRoster={()=>setScreen("roster")}
        onSchoolAdmin={()=>setScreen("schoolAdmin")}
        onGroupMembers={()=>setScreen("groupMembers")}
        onGoalSettings={()=>setScreen("goalSettings")}
        onProfile={()=>setScreen("profile")}
        onTrash={()=>{ setPendingOpenTrash(true); setListMatchMode("tournament"); setScreen("list"); }}
        onLogout={async ()=>{ if(window.confirm("ログアウトしますか？")) { await supabase.auth.signOut(); window.location.reload(); } }}
      />
    );
  }
  if (screen==="goalSettings") {
    return <GoalSettingsScreen onBack={()=>setScreen("master")} />;
  }
  if (screen==="groupMembers") {
    return <GroupMembersScreen onBack={()=>setScreen("master")} />;
  }
  if (screen==="personalAnalysis") {
    return (
      <PersonalAnalysisScreen
        onNavigate={goNav}
        onOpenTeamStats={()=>setScreen("stats")}
      />
    );
  }
  if (screen==="stats") {
    return (
      <StatsScreen
        onNavigate={key=>{ if (key==="stats") { setScreen("personalAnalysis"); return; } goNav(key); }}
        onOpenPlayer={name=>{ setStatsPlayerName(name); setPlayerStatsFrom("stats"); setScreen("playerStats"); }}
        onOpenOpponent={name=>{ setStatsOpponentName(name); setScreen("opponentStats"); }}
        onOpenMatch={id=>{ setMatchId(id); setPrevScreen("stats"); setScreen("record"); }}
      />
    );
  }

  if (screen==="setup") {
    return (
      <MatchSetup
        sourceMatchId={copySourceId}
        editMatchId={editTargetId}
        initialMatchType={initMatchType}
        prefillTournament={creatingFromTournament && tournamentContext ? tournamentContext.name : undefined}
        prefillDate={creatingFromTournament && tournamentContext ? smartTournamentDate(tournamentContext) : undefined}
        prefillVenue={creatingFromTournament && tournamentContext ? tournamentContext.venue : undefined}
        lockTournament={creatingFromTournament && !!tournamentContext}
        tournamentStartDate={creatingFromTournament && tournamentContext ? tournamentContext.start_date : undefined}
        tournamentEndDate={creatingFromTournament && tournamentContext ? tournamentContext.end_date : undefined}
        onScheduled={()=>{
          setInitMatchType(null);
          const fromTournament = creatingFromTournament && tournamentContext;
          setCreatingFromTournament(false);
          if (fromTournament) {
            setScreen("tournamentDetail");
          } else {
            setListFilter("scheduled");
            setScreen("list");
            setTimeout(()=>setListFilter("all"), 100);
          }
        }}
        onSave={id=>{
          setCopySourceId(null);
          setInitMatchType(null);
          setEditTargetId(null);
          setMatchId(id);
          if (prevScreen === "teamMatchRecord") {
            // ★団体戦の番手から編集した場合は、team_matchの文脈を保ったまま番手の記録画面に戻す
            setScreen("teamMatchRecord");
            return;
          }
          const fromTournament = creatingFromTournament && tournamentContext;
          if (!fromTournament) setListMatchMode("individual"); // ★個人戦タブに戻れるようにする
          setPrevScreen(fromTournament ? "tournamentDetail" : "list");
          setCreatingFromTournament(false);
          setScreen("record");
        }}
        onCancel={()=>{
          setCopySourceId(null);
          setInitMatchType(null);
          setCreatingFromTournament(false);
          if (prevScreen === "teamMatchRecord" && editTargetId) {
            // ★団体戦の番手から編集を開いてキャンセルした場合も、同じくteam_matchの文脈に戻す
            setEditTargetId(null);
            setScreen("teamMatchRecord");
          } else if (editTargetId) {
            const back = editTargetId;
            setEditTargetId(null);
            setMatchId(back);
            setScreen("record");
          } else {
            setScreen(prevScreen || "list");
          }
        }}
      />
    );
  }
  if (screen==="record"&&matchId) {
    return (
      <ScoreRecord
        key={matchId+tick}
        matchId={matchId}
        onBack={async ()=>{
          const target = prevScreen==="home" ? "home" : prevScreen==="teamMatchDetail" ? "teamMatchDetail" : prevScreen==="tournamentDetail" ? "tournamentDetail" : prevScreen==="stats" ? "stats" : "list";
          // ★大会詳細に戻るはずなのに、何らかの理由でtournamentContextが失われていた場合はsessionStorageから復元を試みる
          if (target === "tournamentDetail" && !tournamentContext) restoreTournamentReturnCtx();
          setScreen(target); setMatchId(null); await new Promise(r=>setTimeout(r,800)); setTick(t=>t+1);
        }}
        onEdit={id=>{ setEditTargetId(id); setScreen("setup"); }}
        onNavigate={key=>{ setTick(t=>t+1); setMatchId(null); goNav(key); }}
      />
    );
  }
  if (screen==="tournamentDetail" && tournamentContext) {
    return (
      <TournamentDetail
        tournament={tournamentContext}
        initialSeg={tournamentSeg}
        onSegChange={setTournamentSeg}
        onBack={()=>{ setTournamentContext(null); setListMatchMode("tournament"); setScreen("list"); }}
        onSaved={updated=>{ setTournamentContext(updated); setTick(t=>t+1); }}
        onOpenMatch={id=>{ setTournamentSeg("individual"); setMatchId(id); setPrevScreen("tournamentDetail"); setScreen("record"); }}
        onOpenTeamMatch={id=>{ setTournamentSeg("team"); setTeamMatchId(id); setScreen("teamMatchDetail"); }}
        onNewIndividual={()=>{ setTournamentSeg("individual"); setCopySourceId(null); setEditTargetId(null); setInitMatchType(null); setCreatingFromTournament(true); setPrevScreen("tournamentDetail"); setScreen("setup"); }}
        onNewTeam={()=>{ setTournamentSeg("team"); setTeamMatchEditId(null); setTeamMatchCopyId(null); setCreatingFromTournament(true); setScreen("teamMatchSetup"); }}
        onCopyMatch={id=>{ setTournamentSeg("individual"); setCopySourceId(id); setEditTargetId(null); setInitMatchType(null); setCreatingFromTournament(true); setPrevScreen("tournamentDetail"); setScreen("setup"); }}
        onCopyTeamMatch={id=>{ setTournamentSeg("team"); setTeamMatchCopyId(id); setTeamMatchEditId(null); setCreatingFromTournament(true); setScreen("teamMatchSetup"); }}
        onOpenDrawSetup={(seg)=>{ setTournamentSeg(seg); setScreen("drawSetup"); }}
        onOpenDailyRanking={(t)=>{ setTournamentContext(t); setScreen("dailyRanking"); }}
      />
    );
  }
  if (screen==="dailyRanking" && tournamentContext) {
    return (
      <ErrorBoundary>
        <DailyPlayerRankingScreen
          tournament={tournamentContext}
          onBack={()=>setScreen("tournamentDetail")}
        />
      </ErrorBoundary>
    );
  }
  if (screen==="drawSetup" && tournamentContext) {
    return (
      <DrawSetup
        tournament={tournamentContext}
        category={tournamentSeg}
        onBack={()=>setScreen("tournamentDetail")}
      />
    );
  }
  return (
    <MatchList
      key={tick}
      onNew={f=>{ setTournamentContext(null); setCopySourceId(null); setEditTargetId(null); setInitMatchType(f && f!=="all" && f!=="scheduled" ? f : null); setPrevScreen("list"); setScreen("setup"); }}
      onOpen={id=>openMatchSmart(id, { prevScreen:"list", listMatchMode:"individual" })}
      onCopy={id=>{ setCopySourceId(id); setEditTargetId(null); setInitMatchType(null); setPrevScreen("list"); setScreen("setup"); }}
      onStartScheduled={async (id, firstServer)=>{ try { await startScheduledMatch(id, firstServer); setMatchId(id); setListMatchMode("individual"); setPrevScreen("list"); setScreen("record"); setTick(t=>t+1); } catch(e) { alert("試合開始エラー: " + (e?.message || e)); } }}
      onProfile={()=>setScreen("profile")}
      onRoster={()=>setScreen("roster")}
      onSchoolAdmin={()=>setScreen("schoolAdmin")}
      onNavigate={goNav}
      initialFilter={listFilter}
      initialToast={listFilter==="scheduled" ? "📅 試合予定を登録しました！" : null}
      onOpenTeamMatch={id=>{ setTournamentContext(null); setTeamMatchId(id); setListMatchMode("team"); setScreen("teamMatchDetail"); }}
      onNewTeamMatch={()=>{ setTournamentContext(null); setTeamMatchEditId(null); setTeamMatchCopyId(null); setScreen("teamMatchSetup"); }}
      onCopyTeamMatch={id=>{ setTournamentContext(null); setTeamMatchCopyId(id); setTeamMatchEditId(null); setScreen("teamMatchSetup"); }}
      onOpenTournament={t=>{ setTournamentContext(t); setListMatchMode("tournament"); setScreen("tournamentDetail"); }}
      initialMatchMode={listMatchMode}
      initialShowTrash={pendingOpenTrash}
      onTrashConsumed={()=>setPendingOpenTrash(false)}
    />
  );
}
