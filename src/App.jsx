import { useState, useCallback, useEffect, useRef, Component } from "react";
import { supabase } from "./supabase-client";

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "red", fontSize: 13 }}>
          <b>エラーが発生しました</b><br/>
          {this.state.error?.message}<br/>
          {this.state.error?.stack?.slice(0, 300)}
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

// 結果（新規記録時の選択肢：ウィナー / エラーの2択）
const RESULT_TYPES = [
  { key: "winner", label: "ウィナー", is_winner: true  },
  { key: "error",  label: "エラー",   is_winner: false },
];
// ラベル・勝敗判定（過去データに残る "ace" も正しく表示できるよう選択肢とは別管理）
const RESULT_LABELS    = { winner: "ウィナー", ace: "エース", error: "エラー" };
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
  teamA:   "#0ea5e9",
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

// ============================================================
// 統計集計用 共通ヘルパー
// ============================================================
// 指定選手の視点で、その試合が勝ちかどうかを判定（出場していなければnull）
function winForPlayer(m, playerName) {
  const team = m.players.find(p=>p.player_name===playerName)?.team;
  if (!team) return null;
  return team==="A" ? m.match_score_a>m.match_score_b : m.match_score_b>m.match_score_a;
}
// 指定選手の、その試合での相方（ペア）名を取得
function partnerOf(m, playerName) {
  const team = m.players.find(p=>p.player_name===playerName)?.team;
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

// 試合一覧を取得（自分が作成したもののみ。RLSで自動的に絞られる）
async function getMatches() {
  const { data, error } = await supabase
    .from("matches")
    .select("*")
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

  const [{ data: players }, { data: games }, { data: points }, { data: faults }] = await Promise.all([
    supabase.from("match_players").select("*").eq("match_id", id).order("team").order("order_num"),
    supabase.from("games").select("*").eq("match_id", id).order("game_number"),
    supabase.from("points").select("*").eq("match_id", id).order("point_number"),
    supabase.from("faults").select("*").eq("match_id", id).order("fault_number"),
  ]);

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
        is_winner: pt.is_winner, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
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
    is_younger: match.is_younger === true,
  };
  const { error: mErr } = await supabase.from("matches").upsert(matchRow);
  if (mErr) throw mErr;

  // 選手情報：一旦削除してから入れ直す（シンプルで確実な方式）
  await supabase.from("match_players").delete().eq("match_id", match.id);
  if (match.players?.length) {
    const playerRows = match.players.map(p => ({
      id: p.id, match_id: match.id, team: p.team, player_name: p.player_name,
      club_name: p.club_name || null, position: p.position || null, order_num: p.order_num,
    }));
    const { error: pErr } = await supabase.from("match_players").insert(playerRows);
    if (pErr) throw pErr;
  }

  // ゲーム・ポイント・フォルトも同様に、入れ直す
  await supabase.from("games").delete().eq("match_id", match.id);
  for (const g of (match.games ?? [])) {
    const gameRow = {
      id: g.id, match_id: match.id, game_number: g.game_number, server_team: g.server_team,
      is_final: g.is_final, score_a: g.score_a, score_b: g.score_b, winner_team: g.winner_team || null,
    };
    const { error: gErr } = await supabase.from("games").insert(gameRow);
    if (gErr) throw gErr;

    if (g.points?.length) {
      const pointRows = g.points.map(pt => ({
        id: pt.id, game_id: g.id, match_id: match.id, point_number: pt.point_number,
        scoring_team: pt.scoring_team, player_name: pt.player_name || null,
        shot_type: toShotType(pt.play_type, pt.result_type),
        play_type: pt.play_type || null, side_type: pt.side_type || null, result_type: pt.result_type || null,
        is_winner: pt.is_winner, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
      }));
      const { error: ptErr } = await supabase.from("points").insert(pointRows);
      if (ptErr) throw ptErr;
    }
    if (g.faults?.length) {
      const faultRows = g.faults.map(f => ({
        id: f.id, game_id: g.id, match_id: match.id, fault_number: f.fault_number,
        server_team: f.server_team, player_name: f.player_name || null,
        score_a_at: f.score_a_at, score_b_at: f.score_b_at,
      }));
      const { error: fErr } = await supabase.from("faults").insert(faultRows);
      if (fErr) throw fErr;
    }
  }
}

async function deleteMatch(id) {
  const { error } = await supabase.from("matches").delete().eq("id", id);
  if (error) throw error;
}

// ============================================================
// 団体戦データ関数
// ============================================================
async function getTeamMatches() {
  const { data, error } = await supabase
    .from("team_matches")
    .select("*")
    .order("match_date", { ascending: false });
  if (error) { console.error(error); return []; }
  // 各試合の詳細を取得
  const result = [];
  for (const tm of data ?? []) {
    const matchIds = [tm.match_id_1, tm.match_id_2, tm.match_id_3].filter(Boolean);
    const matches = [];
    for (const mid of matchIds) {
      const m = await getMatch(mid);
      if (m) matches.push(m);
    }
    result.push({ ...tm, matches });
  }
  return result;
}

async function saveTeamMatch(tm) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const row = {
    id: tm.id || uid(),
    created_by: user.id,
    match_date: tm.match_date,
    tournament_name: tm.tournament_name || null,
    venue: tm.venue || null,
    opponent_name: tm.opponent_name,
    format: tm.format || "best_of_3",
    finish_early: tm.finish_early !== false,
    match_id_1: tm.match_id_1 || null,
    match_id_2: tm.match_id_2 || null,
    match_id_3: tm.match_id_3 || null,
  };
  const { error } = await supabase.from("team_matches").upsert(row);
  if (error) throw error;
  return row.id;
}

async function deleteTeamMatch(id) {
  const { error } = await supabase.from("team_matches").delete().eq("id", id);
  if (error) throw error;
}

function calcTeamResult(tm) {
  // 各試合の勝敗を判定
  const results = (tm.matches || []).map(m => {
    if (m.status !== "finished") return null;
    return m.match_score_a > m.match_score_b ? "win" : "lose";
  });
  const wins = results.filter(r => r === "win").length;
  const loses = results.filter(r => r === "lose").length;
  const isWin = wins >= 2;
  return { wins, loses, results, isWin };
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
  return data;
}

async function saveMyProfile(profile) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const { error } = await supabase.from("users").update({
    name: profile.name,
    school_id: profile.school_id,
    prefecture: profile.prefecture,
    category: profile.category,
    gender_category: profile.gender_category,
    linked_player_id: profile.linked_player_id ?? null,
  }).eq("id", user.id);
  if (error) throw error;
}

// ============================================================
// 学校マスター（閲覧は誰でも可、追加・編集・削除は管理者のみ）
// ============================================================
async function getSchools() {
  const { data, error } = await supabase.from("schools").select("*").order("name");
  if (error) { console.error(error); return []; }
  return data;
}

async function addSchool(name, prefecture, category, genderRestriction) {
  const row = { id: uid(), name: name.trim(), prefecture: prefecture || null, category: category || null, gender_restriction: genderRestriction || "mixed" };
  const { error } = await supabase.from("schools").insert(row);
  if (error) throw error;
  return row;
}

async function updateSchoolMaster(id, updates) {
  const { error } = await supabase.from("schools").update(updates).eq("id", id);
  if (error) throw error;
}

async function deleteSchoolMaster(id) {
  const { error } = await supabase.from("schools").delete().eq("id", id);
  if (error) throw error;
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
    const existingNames = new Set(roster.map(p => p.player_name));
    // すでに完全一致する名前がある場合はスキップ
    if (existingNames.has(baseName)) return;
    // 連番チェック（「田中 蓮2」「田中 蓮3」などがある場合に次の番号を使う）
    let finalName = baseName;
    let n = 2;
    while (existingNames.has(finalName)) {
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
  const profile = await getMyProfile();
  const row = {
    id: player.id || uid(),
    school_id: profile?.school_id || null,
    gender_category: profile?.gender_category || null,
    player_name: player.player_name,
    position: player.position || null,
    dominant_hand: player.dominant_hand || null,
    is_own_team: player.is_own_team !== false,
    team_name: player.team_name || null,
    created_by: user.id,
  };
  const { error } = await supabase.from("players").upsert(row);
  if (error) throw error;
  return row;
}

async function deletePlayerFromRoster(id) {
  const { error } = await supabase.from("players").delete().eq("id", id);
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
// ゲームロジック
// ============================================================
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
  // 選手名 -> 所属チーム('A'/'B') の対応表（match_playersが正、scoring_teamには依存しない）
  const teamOf = {};
  for (const p of match.players) teamOf[p.player_name] = p.team;

  const result = {};
  for (const g of match.games) {
    for (const pt of g.points) {
      if (!pt.player_name) continue;
      const playerTeam = teamOf[pt.player_name] ?? pt.scoring_team;
      const key = playerTeam + "__" + pt.player_name;
      if (!result[key]) result[key] = { team: playerTeam, player_name: pt.player_name, total: 0, winners: 0, errors: 0, plays: {}, results: {} };
      const r = result[key];
      r.total++;
      if (pt.is_winner) r.winners++; else r.errors++;
      if (pt.play_type)   r.plays[pt.play_type]     = (r.plays[pt.play_type]   ?? 0) + 1;
      if (pt.result_type) r.results[pt.result_type] = (r.results[pt.result_type] ?? 0) + 1;
    }
    for (const f of (g.faults ?? [])) {
      if (!f.player_name) continue;
      const playerTeam = teamOf[f.player_name] ?? f.server_team;
      const key = playerTeam + "__" + f.player_name;
      if (!result[key]) result[key] = { team: playerTeam, player_name: f.player_name, total: 0, winners: 0, errors: 0, plays: {}, results: {} };
      result[key].plays["fault"] = (result[key].plays["fault"] ?? 0) + 1;
    }
  }
  return Object.values(result);
}

function calcAutoComment(stats, team) {
  const comments = [];
  for (const p of stats.filter(s => s.team === team)) {
    const topPlay   = Object.entries(p.plays).sort((a,b)=>b[1]-a[1])[0];
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

// LINE共有テキスト
// LINE共有テキスト
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
      const pl = match.players.find(p=>p.player_name===f.player_name);
      rows.push([match.match_date,match.tournament_name??"",match.round??"",g.game_number,g.is_final?"YES":"NO","","",f.server_team==="A"?"自チーム":"相手チーム",f.player_name??"",pl?.club_name??""," 1stフォルト","","fault",f.score_a_at,f.score_b_at]);
    }
    for (const pt of g.points) {
      const pl = match.players.find(p=>p.player_name===pt.player_name);
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
function Modal({ children, onClose }) {
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:20,padding:"28px 20px",width:"100%",maxWidth:340 }} onClick={e=>e.stopPropagation()}>{children}</div>
    </div>
  );
}

function NavBar({ active, onNavigate }) {
  const items = [
    ["home",   "🏠", "ホーム"],
    ["list",   "📋", "履歴"],
    ["stats",  "📊", "分析"],
    ["master", "🗂",  "マスター"],
  ];
  return (
    <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:10 }}>
      {items.map(([key,icon,label])=>(
        <div key={key} onClick={()=>onNavigate&&onNavigate(key)} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"6px 0 4px",fontSize:9,fontWeight:600,color:active===key?C.accent:C.textSec,cursor:"pointer" }}>
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
function MatchList({ onNew, onOpen, onCopy, onProfile, onRoster, onSchoolAdmin, onNavigate, onStartScheduled, initialFilter, initialToast }) {
  const [filter, setFilter] = useState(initialFilter || "all");
  const [toast, setToast] = useState(initialToast || null);
  useEffect(() => { if (toast) { const t = setTimeout(()=>setToast(null), 3000); return ()=>clearTimeout(t); } }, [toast]);
  const [childOnly, setChildOnly] = useState(false);
  const [allMatches, setAllMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null); // 削除確認対象のmatch_id
  const [serveSelectMatch, setServeSelectMatch] = useState(null); // サーブ選択モーダル対象の試合
  const [isAdmin, setIsAdmin] = useState(false);
  const [myId, setMyId] = useState(null);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 6;

  const [allTeamMatches, setAllTeamMatches] = useState([]);
  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([getMatches(), getTeamMatches()]).then(([list, tmList]) => {
      setAllMatches(list);
      setAllTeamMatches(tmList);
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
    })();
  }, []);

  const matches = allMatches
    .filter(m=> filter==="active" ? m.status==="active" : filter==="scheduled" ? m.status==="scheduled" : (filter==="all"||m.match_type===filter))
    .filter(m=> filter==="scheduled" ? true : m.status!=="scheduled") // 予定以外のタブでは予定を除外
    .filter(m=>!childOnly || m.players.some(p=>p.player_name===linkedPlayerName))
    .filter(m=> {
      // 団体戦の個別試合（1番手・2番手・3番手）は試合一覧から除外
      const tmIds = allTeamMatches.flatMap(tm=>[tm.match_id_1,tm.match_id_2,tm.match_id_3].filter(Boolean));
      return !tmIds.includes(m.id);
    });

  // 予定タブで表示する団体戦
  const teamMatchesForList = filter==="scheduled" || filter==="all"
    ? allTeamMatches.filter(tm => {
        const allFinished = tm.matches.every(m=>m.status==="finished");
        if (filter==="scheduled") return !allFinished;
        return true;
      })
    : [];

  // ★絞り込み条件が変わったら1ページ目に戻す
  useEffect(() => { setPage(1); }, [filter, childOnly]);

  const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const pageMatches = matches.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);

  async function handleDelete(id) {
    await deleteMatch(id);
    setConfirmDelete(null);
    reload();
  }

  return (
    <div style={S.page}>
      <div style={{ ...S.hdr, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>試合一覧</span>
        <button
          style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:13, padding:"6px 10px", cursor:"pointer" }}
          onClick={reload}
        >🔄 更新</button>
      </div>
      {toast && (
        <div style={{ position:"fixed", top:60, left:"50%", transform:"translateX(-50%)", background:"#1b5e20", color:"#fff", padding:"10px 20px", borderRadius:20, fontSize:13, fontWeight:700, zIndex:9999, boxShadow:"0 4px 12px rgba(0,0,0,0.2)", whiteSpace:"nowrap" }}>
          {toast}
        </div>
      )}
      <div style={{ display:"flex",gap:6,padding:"12px 14px 0",overflowX:"auto" }}>
        <button style={{ ...S.togBtn(filter==="active", "#e53935"), whiteSpace:"nowrap", fontSize:12, fontWeight: filter==="active" ? 800 : 600, border: filter==="active" ? "none" : "1.5px solid #e53935", color: filter==="active" ? C.white : "#e53935" }} onClick={()=>setFilter("active")}>🔴 進行中</button>
        <button style={{ ...S.togBtn(filter==="scheduled", "#7b1fa2"), whiteSpace:"nowrap", fontSize:12, fontWeight: filter==="scheduled" ? 800 : 600, border: filter==="scheduled" ? "none" : "1.5px solid #7b1fa2", color: filter==="scheduled" ? C.white : "#7b1fa2" }} onClick={()=>setFilter("scheduled")}>📅 予定</button>
        {[["all","すべて"],["tournament","公式大会"],["practice","練習試合"],["internal","部内戦"]].map(([v,l])=>(
          <button key={v} style={{ ...S.togBtn(filter===v,C.navy),whiteSpace:"nowrap",fontSize:12 }} onClick={()=>setFilter(v)}>{l}</button>
        ))}
      </div>
      {linkedPlayerName && (
        <div style={{ display:"flex",gap:8,padding:"8px 14px 0",flexWrap:"wrap" }}>
          <button
            style={{ ...S.togBtn(childOnly,C.navy),fontSize:12,padding:"6px 12px" }}
            onClick={()=>setChildOnly(v=>!v)}
          >🎾 {linkedPlayerName}さんの試合のみ</button>
        </div>
      )}
      <div style={{ padding:"12px 14px" }}>
        {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>}
        {!loading && matches.length===0 && teamMatchesForList.length===0 && <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}><div style={{ fontSize:40,marginBottom:12 }}>🎾</div>試合記録がありません</div>}
        {/* 団体戦カード */}
        {!loading && teamMatchesForList.map(tm=>{
          const { wins, loses, isWin } = calcTeamResult(tm);
          const finished = tm.matches.filter(m=>m.status==="finished").length;
          const total = tm.matches.length;
          return (
            <div key={tm.id} style={{ ...S.card, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:10 }}>
              <div style={{ height:4, background: finished===0 ? "#7b1fa2" : isWin ? C.teamA : C.teamB }} />
              <div style={{ padding:"12px 14px", cursor:"pointer" }} onClick={()=>{ onNavigate && onNavigate("teamMatchDetail_"+tm.id); }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:13,fontWeight:700 }}>{tm.tournament_name||"団体戦"}</span>
                  <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(tm.match_date)}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                  <div>
                    <div style={{ fontSize:11,color:C.textSec }}>自チーム</div>
                    <div style={{ fontSize:14,fontWeight:700 }}>vs {tm.opponent_name}</div>
                  </div>
                  <span style={{ fontSize:20,fontWeight:900, color: finished===0?"#7b1fa2":isWin?C.teamA:C.red }}>
                    {finished===0?"予定":`${wins}勝${loses}敗`}
                  </span>
                </div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:"#f3e5f5",color:"#7b1fa2",fontWeight:700 }}>🏆 団体戦</span>
                  <span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:C.navyMid+"22",color:C.navyMid,fontWeight:600 }}>{tm.finish_early?"2勝終了":"3試合全部"}</span>
                  {finished===0 && <span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:"#f3e5f5",color:"#7b1fa2",fontWeight:600 }}>📅 予定</span>}
                </div>
              </div>
              <div style={{ padding:"10px 14px", borderTop:"1px solid "+C.border, background:"#f3e5f5", display:"flex", gap:8 }}>
                <button
                  style={{ flex:1, padding:"10px 0", background:"linear-gradient(135deg,#7b1fa2,#9c27b0)", color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}
                  onClick={e=>{ e.stopPropagation(); onNavigate && onNavigate("teamMatchDetail_"+tm.id); }}
                >🎾 詳細・記録</button>
                <button
                  style={{ padding:"10px 12px", background:"#fff", color:"#7b1fa2", border:"1px solid #7b1fa2", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}
                  onClick={async e=>{ e.stopPropagation(); if (!window.confirm("この団体戦を削除しますか？\n（個人戦データは残ります）")) return; await deleteTeamMatch(tm.id); reload(); }}
                >🗑</button>
              </div>
            </div>
          );
        })}
        {!loading && pageMatches.map(m=>{
          const aWin=m.match_score_a>m.match_score_b;
          const aP=m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
          const bP=m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
          const aC=m.players.find(p=>p.team==="A")?.club_name??"";
          const bC=m.players.find(p=>p.team==="B")?.club_name??"";
          const isYoungerM = m.is_younger === true;
          const rows = isYoungerM
            ? [["A",aC,aP,m.match_score_a,aWin,C.teamA],["B",bC,bP,m.match_score_b,!aWin&&m.status==="finished",C.teamB]]
            : [["B",bC,bP,m.match_score_b,!aWin&&m.status==="finished",C.teamB],["A",aC,aP,m.match_score_a,aWin,C.teamA]];
          return (
            <div key={m.id} style={{ ...S.card,boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
              <div style={{ height:4,background:m.status==="finished"?(aWin?C.teamA:C.teamB):C.accent }}/>
              <div style={{ padding:"12px 14px",cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                  <span style={{ fontSize:13,fontWeight:700 }}>{m.tournament_name||"試合"}{m.round?` · ${m.round}`:""}</span>
                  <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(m.match_date)}</span>
                </div>
                {(m.venue||m.court_number)&&<div style={{ fontSize:11,color:C.textSec,marginBottom:6 }}>📍 {[m.venue,m.court_number].filter(Boolean).join(" · ")}</div>}
                {rows.map(([t,club,names,sc,win,col])=>(
                  <div key={t} style={{ display:"flex",alignItems:"center",padding:"2px 0" }}>
                    <span style={{ width:18,fontSize:13 }}>{win?"🏆":""}</span>
                    <div style={{ flex:1 }}>
                      {club && <div style={{ fontSize:11,color:C.textSec,marginBottom:1 }}>{club}</div>}
                      <div style={{ fontSize:13,fontWeight:win?700:400 }}>{names}</div>
                    </div>
                    <span style={{ fontSize:22,fontWeight:800,color:win?col:C.textSec }}>{sc??"-"}</span>
                  </div>
                ))}
                {/* 進行中：現在のゲームスコア表示 */}
                {m.status==="active" && m.games && m.games.length > 0 && (() => {
                  const activeGame = m.games.find(g => !g.winner_team);
                  const finishedGames = m.games.filter(g => g.winner_team);
                  return (
                    <div style={{ marginTop:6, padding:"6px 10px", background:"rgba(0,0,0,0.04)", borderRadius:8 }}>
                      <div style={{ fontSize:10, color:C.textSec, marginBottom:3, fontWeight:600 }}>現在のスコア</div>
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                        {finishedGames.map(g => (
                          <span key={g.id} style={{ fontSize:11, padding:"2px 7px", borderRadius:12, background: g.winner_team==="A" ? C.teamA+"22" : C.teamB+"22", color: g.winner_team==="A" ? C.teamA : C.teamB, fontWeight:700 }}>
                            G{g.game_number}: {g.score_a}-{g.score_b}
                          </span>
                        ))}
                        {activeGame && (
                          <span style={{ fontSize:11, padding:"2px 7px", borderRadius:12, background:"#fff3cd", color:"#7a5800", fontWeight:700 }}>
                            G{activeGame.game_number}: {activeGame.score_a}-{activeGame.score_b} 🔴
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                <div style={{ marginTop:8,display:"flex",justifyContent:"flex-end",gap:6 }}>
                  {[`${m.game_format}Gマッチ`,MATCH_TYPES.find(t=>t.key===m.match_type)?.label].filter(Boolean).map(l=>(
                    <span key={l} style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:C.navyMid+"22",color:C.navyMid,fontWeight:600 }}>{l}</span>
                  ))}
                  {m.status==="active"&&<span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:"#fff3cd",color:"#7a5800",fontWeight:600 }}>進行中</span>}
                  {m.status==="scheduled"&&<span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:"#f3e5f5",color:"#7b1fa2",fontWeight:600 }}>📅 予定</span>}
                </div>
              </div>
              {/* 予定の場合：試合を開始するボタン */}
              {m.status==="scheduled" && (
                <div style={{ padding:"10px 14px", borderTop:"1px solid "+C.border, background:"#f3e5f5" }}>
                  <button
                    style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13 }}
                    onClick={(e)=>{ e.stopPropagation(); if (!m.first_server) { setServeSelectMatch(m); } else { onStartScheduled(m.id, m.first_server); } }}
                  >🎾 この試合を開始する</button>
                </div>
              )}
              {/* コピー・削除ボタン行 */}
              <div style={{ display:"flex",borderTop:"1px solid "+C.border }}>
                <button
                  style={{ flex:1,padding:"9px",background:"#f0f6ff",color:"#1565c0",border:"none",fontSize:12,fontWeight:700,cursor:"pointer" }}
                  onClick={(e)=>{ e.stopPropagation(); onCopy(m.id); }}
                >📋 この試合情報をコピーして新規作成</button>
                <button
                  style={{ width:64,padding:"9px",background:"#fdecea",color:C.red,border:"none",borderLeft:"1px solid "+C.border,fontSize:12,fontWeight:700,cursor:"pointer" }}
                  onClick={(e)=>{ e.stopPropagation(); setConfirmDelete(m.id); }}
                >🗑 削除</button>
              </div>
            </div>
          );
        })}
        {!loading && totalPages>1 && (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:16,marginTop:8,marginBottom:8 }}>
            {page>1 ? (
              <button
                style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:12,width:84 }}
                onClick={()=>setPage(p=>Math.max(1,p-1))}
              >← 前へ</button>
            ) : <div style={{ width:84 }} />}
            <span style={{ fontSize:12,color:C.textSec }}>{page} / {totalPages}</span>
            {page<totalPages ? (
              <button
                style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:12,width:84 }}
                onClick={()=>setPage(p=>Math.min(totalPages,p+1))}
              >次へ →</button>
            ) : <div style={{ width:84 }} />}
          </div>
        )}
      </div>
      <button style={{ position:"fixed",bottom:72,left:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.accent},#00a066)`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,194,122,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={()=>onNew(filter)}>＋</button>
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
                <button key={team}
                  style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?C.teamA:C.teamB}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?C.teamA:C.teamB }}
                  onClick={async ()=>{
                    const m = serveSelectMatch;
                    setServeSelectMatch(null);
                    await onStartScheduled(m.id, team);
                  }}
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
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>削除すると元に戻せません。スコア・スタッツデータもすべて削除されます。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDelete(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>handleDelete(confirmDelete)}>削除する</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// ホーム画面（ダッシュボード）
// ============================================================
// ============================================================
// マスター管理ハブ画面（選手マスター・学校マスターへの入口）
// ============================================================
function MasterScreen({ onNavigate, onRoster, onSchoolAdmin, onTeamMatch }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { getMyProfile().then(p=>setIsAdmin(!!p?.is_admin)); }, []);

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>マスター管理</span>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        <div
          style={{ ...S.card, padding:"16px 14px", marginBottom:10, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onTeamMatch}
        >
          <div>
            <div style={{ fontSize:15,fontWeight:700,marginBottom:2 }}>🏆 団体戦</div>
            <div style={{ fontSize:12,color:C.textSec }}>団体戦の記録・結果管理</div>
          </div>
          <span style={{ fontSize:18,color:C.textSec }}>›</span>
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
            style={{ ...S.card, padding:"16px 14px", cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
            onClick={onSchoolAdmin}
          >
            <div>
              <div style={{ fontSize:14,fontWeight:700 }}>🛠 学校マスター管理</div>
              <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>学校・チームの一覧を管理（管理者専用）</div>
            </div>
            <span style={{ fontSize:16,color:C.textSec }}>→</span>
          </div>
        )}
      </div>
      <NavBar active="master" onNavigate={onNavigate}/>
    </div>
  );
}

function HomeScreen({ onNew, onOpen, onNavigate, onGoPlayerStats, onProfile }) {
  const [allMatches, setAllMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);

  useEffect(() => { getMatches().then(list=>{ setAllMatches(list); setLoading(false); }); }, []);
  useEffect(() => {
    (async () => {
      const p = await getMyProfile();
      setProfile(p);
      if (p?.linked_player_id) {
        const roster = await getPlayerRoster();
        const found = roster.find(r => r.id === p.linked_player_id);
        setLinkedPlayerName(found?.player_name ?? null);
      }
    })();
  }, []);

  const finished = allMatches.filter(m=>m.status==="finished");
  const wins = finished.filter(m=>m.match_score_a>m.match_score_b).length;
  const winRate = finished.length>0 ? Math.round(wins/finished.length*100) : 0;
  const recent = allMatches.slice(0,3);

  // ★紐づけ選手（お子さん/自分）の戦績を、この画面で直接計算する
  const linkedMatches = linkedPlayerName ? allMatches.filter(m => m.players.some(p=>p.player_name===linkedPlayerName)) : [];
  const linkedFinished = linkedMatches.filter(m=>m.status==="finished");
  function linkedIsWin(m) {
    const onA = m.players.some(p => p.team==="A" && p.player_name===linkedPlayerName);
    return onA ? m.match_score_a>m.match_score_b : m.match_score_b>m.match_score_a;
  }
  const linkedWins = linkedFinished.filter(linkedIsWin).length;
  const linkedWinRate = linkedFinished.length>0 ? Math.round(linkedWins/linkedFinished.length*100) : 0;

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span style={{ fontSize:20,fontWeight:800,color:C.white }}>
            {profile?.name ? `${profile.name}さん、こんにちは` : "ホーム"}
          </span>
          <div style={{ display:"flex",gap:6 }}>
            <button
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:14, padding:"6px 9px", cursor:"pointer" }}
              onClick={onProfile} title="プロフィール"
            >👤</button>
            <button
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, color:C.white, fontSize:11, padding:"6px 10px", cursor:"pointer" }}
              onClick={async ()=>{ if(window.confirm("ログアウトしますか？")) { await supabase.auth.signOut(); } }}
            >ログアウト</button>
          </div>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : (
          <>
            {/* サマリーカード */}
            <div style={{ ...S.card, padding:16, marginBottom:14 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",textAlign:"center" }}>
                <div>
                  <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{finished.length}</div>
                  <div style={{ fontSize:11,color:C.textSec }}>総試合数</div>
                </div>
                <div>
                  <div style={{ fontSize:22,fontWeight:800,color:C.accent }}>{winRate}%</div>
                  <div style={{ fontSize:11,color:C.textSec }}>勝率</div>
                </div>
                <div>
                  <div style={{ fontSize:22,fontWeight:800,color:C.navy }}>{wins}勝{finished.length-wins}敗</div>
                  <div style={{ fontSize:11,color:C.textSec }}>戦績</div>
                </div>
              </div>
            </div>

            <button style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:14 }} onClick={onNew}>＋ 新規試合を記録する</button>

            {linkedPlayerName && (
              <div style={{ ...S.card, padding:16, marginBottom:14, border:`1px solid ${C.navy}22` }}>
                <div style={{ fontSize:13,fontWeight:700,color:C.navy,marginBottom:10 }}>🎾 {linkedPlayerName}さんの戦績</div>
                {linkedFinished.length===0 ? (
                  <div style={{ fontSize:12,color:C.textSec }}>まだ試合記録がありません</div>
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
                    <span style={{ fontSize:14,fontWeight:800,color:m.status==="finished"?(aWin?C.teamA:C.teamB):C.textSec }}>
                      {m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : "進行中"}
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
// 統計画面（複数試合をまたいだ分析）
// ============================================================
function StatsScreen({ onNavigate, onOpenPlayer, onOpenOpponent }) {
  const [allMatches, setAllMatches] = useState([]);
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("team"); // team | players | opponents
  const [teamSubTab, setTeamSubTab] = useState("overall"); // overall | pairs
  const [period, setPeriod] = useState("all"); // all | month1
  const [sort, setSort] = useState("desc"); // desc | asc

  useEffect(() => { getMatches().then(list=>{ setAllMatches(list); setLoading(false); }); }, []);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);

  const periodMatches = period==="month1" ? withinLastDays(allMatches, 30) : allMatches;
  const finished = periodMatches.filter(m=>m.status==="finished");
  const teamRecord = recordOf(finished, m=>m.match_score_a>m.match_score_b);

  // ペア別成績（自チームAのペア名を「選手1／選手2」形式で集計）
  const byPair = {};
  finished.forEach(m => {
    const aPlayers = m.players.filter(p => p.team === "A").sort((a,b) => a.order_num - b.order_num);
    const pairKey = aPlayers.map(p => p.player_name).filter(Boolean).join("／") || "（不明）";
    (byPair[pairKey] ??= []).push(m);
  });
  const pairRows = Object.entries(byPair).map(([name, list]) => ({
    name, ...recordOf(list, m => m.match_score_a > m.match_score_b),
  }));
  pairRows.sort((a,b) => sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 選手別成績（選手マスターの自チーム選手のみ）
  const playerRows = roster.filter(p=>p.is_own_team!==false).map(p=>{
    const myMatches = finished.filter(m=>m.players.some(pl=>pl.player_name===p.player_name));
    const rec = recordOf(myMatches, m=>winForPlayer(m,p.player_name));
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

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>統計</span>
      </div>
      <div style={{ display:"flex",gap:6,padding:"12px 14px 0" }}>
        {[["team","自チーム"],["players","選手別"],["opponents","対戦相手別"]].map(([v,l])=>(
          <button key={v} style={{ ...S.togBtn(tab===v,C.navy),flex:1,fontSize:12,padding:"8px 4px" }} onClick={()=>setTab(v)}>{l}</button>
        ))}
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>読み込み中...</div>
        ) : allMatches.filter(m=>m.status==="finished").length===0 ? (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>集計できる試合がまだありません</div>
        ) : tab==="team" ? (
          <>
            <PeriodSortBar period={period} setPeriod={setPeriod} sort={sort} setSort={setSort} />
            {/* 自チームサブタブ：総合／ペア別 */}
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {[["overall","総合成績"],["pairs","ペア別"]].map(([v,l])=>(
                <button key={v} style={{ ...S.togBtn(teamSubTab===v, C.accent), flex:1, fontSize:12, padding:"7px 4px" }} onClick={()=>setTeamSubTab(v)}>{l}</button>
              ))}
            </div>
            {teamSubTab==="overall" ? (
              <>
                <div style={{ ...S.card, padding:16, marginBottom:16 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:10 }}>総合成績</div>
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
                <MonthlyTrendCard finishedMatches={allMatches.filter(m=>m.status==="finished")} winFn={m=>m.match_score_a>m.match_score_b} />
              </>
            ) : (
              <>
                {pairRows.length===0 ? (
                  <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この期間の試合記録がありません</div>
                ) : pairRows.map(r=>(
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
        ) : tab==="players" ? (
          <>
            <PeriodSortBar period={period} setPeriod={setPeriod} sort={sort} setSort={setSort} />
            <div style={{ fontSize:11,color:C.textSec,marginBottom:8 }}>タップすると、その選手のペア別成績を見られます</div>
            {playerRows.length===0 ? (
              <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この期間の試合記録がありません</div>
            ) : playerRows.map(r=>(
              <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }} onClick={()=>onOpenPlayer(r.name)}>
                <span style={{ fontSize:14,fontWeight:700 }}>{r.name}</span>
                <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
              </div>
            ))}
          </>
        ) : (
          <>
            <PeriodSortBar period={period} setPeriod={setPeriod} sort={sort} setSort={setSort} />
            <div style={{ fontSize:11,color:C.textSec,marginBottom:8 }}>タップすると、相手選手・ペア別の成績を見られます</div>
            {opponentRows.length===0 ? (
              <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>この期間の試合記録がありません</div>
            ) : opponentRows.map(r=>(
              <div key={r.name} style={{ ...S.card, padding:"12px 14px", marginBottom:8, cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }} onClick={()=>onOpenOpponent(r.name)}>
                <span style={{ fontSize:14,fontWeight:700 }}>{r.name}</span>
                <span style={{ fontSize:12,color:C.textSec }}>{r.wins}勝{r.losses}敗（{r.total}試合）・<span style={{ fontWeight:700,color:C.accent }}>{r.rate}%</span></span>
              </div>
            ))}
          </>
        )}
      </div>
      <NavBar active="stats" onNavigate={onNavigate}/>
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

  useEffect(() => {
    (async () => {
      const profile = await getMyProfile();
      const rosterList = await getPlayerRoster();
      setRoster(rosterList);
      if (profile?.linked_player_id) {
        const found = rosterList.find(p => p.id === profile.linked_player_id);
        setLinkedPlayerName(found?.player_name ?? null);
      }
      const list = await getMatches();
      setMatches(list);
      setLoading(false);
    })();
  }, []);

  const periodMatches = period==="month1" ? withinLastDays(matches, 30) : matches;
  const ownRoster = roster.filter(p=>p.is_own_team!==false);
  const myMatches = playerName ? periodMatches.filter(m => m.players.some(p => p.player_name === playerName)) : [];
  const finished = myMatches.filter(m => m.status === "finished");
  const rec = recordOf(finished, m=>winForPlayer(m, playerName));

  // ペア（相方）別成績
  const byPartner = {};
  finished.forEach(m=>{
    const partner = partnerOf(m, playerName) || "（相方不明）";
    (byPartner[partner] ??= []).push(m);
  });
  const partnerRows = Object.entries(byPartner).map(([name,list])=>({
    name, ...recordOf(list, m=>winForPlayer(m,playerName)),
  }));
  partnerRows.sort((a,b)=> sort==="desc" ? b.rate-a.rate : a.rate-b.rate);

  // 全試合（未確定含む）は日付の新しい順表示用に元のmyMatchesを使う（期間でフィルタ済み）
  const allFinishedForTrend = playerName ? matches.filter(m=>m.status==="finished" && m.players.some(p=>p.player_name===playerName)) : [];

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
                          {m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : "進行中"}
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
                          {m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : "進行中"}
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
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden" }}>{children}</div>
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
function VenueField({ value, onChange, venues }) {
  const safeValue = value ?? "";
  const safeVenues = venues ?? [];
  const filtered = safeValue.trim() ? safeVenues.filter(v => v.includes(safeValue.trim())) : [];
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position:"relative" }}>
      <input style={S.inp} placeholder="例：○○市民コート" value={safeValue}
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

// ★学校名の誤入力防止用：候補から選ぶ（プルダウン）か、新しい名前を自由入力するか切り替えられる部品
// schools は {name, prefecture}[] 形式（prefectureはnullの場合あり）
// prefFilter: 親から渡される都道府県絞り込み値（任意）
function SchoolField({ value, onChange, schools, placeholder, prefFilter }) {
  const [customMode, setCustomMode] = useState(!!value && !schools.some(s => s.name === value));

  useEffect(() => {
    // 候補一覧が後から読み込まれた場合、まだ何も入力していなければ一覧モードに切り替える
    if (!value && schools.length>0 && customMode) setCustomMode(false);
  }, [schools]);

  const visibleSchools = prefFilter ? schools.filter(s => s.prefecture === prefFilter) : schools;

  if (customMode) {
    return (
      <div>
        <input style={S.inp} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)} />
        {schools.length>0 && (
          <button style={{ background:"none",border:"none",color:C.accent,fontSize:11,fontWeight:700,cursor:"pointer",marginTop:4,padding:0 }} onClick={()=>setCustomMode(false)}>← 一覧から選ぶ</button>
        )}
      </div>
    );
  }

  return (
    <select
      style={{ ...S.inp, background:"transparent" }}
      value={visibleSchools.some(s=>s.name===value) ? value : ""}
      onChange={e=>{
        if (e.target.value === "__custom__") { setCustomMode(true); }
        else onChange(e.target.value);
      }}
    >
      <option value="">選択してください</option>
      {visibleSchools.map(s => <option key={s.name} value={s.name}>{s.name}{s.prefecture ? `（${s.prefecture}）` : ""}</option>)}
      <option value="__custom__">＋ 新しい学校名を入力</option>
    </select>
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
function MatchSetup({ onSave, onCancel, sourceMatchId, editMatchId, initialMatchType, onScheduled }) {
  const [ready, setReady] = useState(!editMatchId && !sourceMatchId);
  const [editing, setEditing] = useState(null);
  const [source,  setSource]  = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [e, s] = await Promise.all([
        editMatchId ? getMatch(editMatchId) : Promise.resolve(null),
        sourceMatchId ? getMatch(sourceMatchId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setEditing(e); setSource(s); setReady(true);
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
  return <MatchSetupForm onSave={onSave} onCancel={onCancel} editing={editing} source={source} initialMatchType={initialMatchType} onScheduled={onScheduled} />;
}

function MatchSetupForm({ onSave, onCancel, editing, source, initialMatchType, onScheduled }) {
  const base    = editing || source;

  // 試合開始済み（active/finished）の場合のみ形式設定をロック
  // 予定（scheduled）は編集可能
  const locked = !!editing && (editing.status === "active" || editing.status === "finished");

  const aBase = base ? base.players.find(p=>p.team==="A") : null;
  const aBase2 = base ? base.players.find(p=>p.team==="A" && p.order_num===2) : null;
  const bBase = base ? base.players.find(p=>p.team==="B") : null;
  const bBase2 = base ? base.players.find(p=>p.team==="B" && p.order_num===2) : null;

  // ★各フィールドを独立したstateに分離（フォーカス維持のため）
  const [matchDate,      setMatchDate]      = useState(base?.match_date ?? today());
  const [venue,          setVenue]          = useState(base?.venue ?? "");
  const [tournamentName, setTournamentName] = useState(base?.tournament_name ?? "");
  const [round,          setRound]          = useState(base?.round ?? "");
  const [matchType,      setMatchType]      = useState(base?.match_type ?? initialMatchType ?? "tournament");
  const [courtNumber,    setCourtNumber]    = useState(base?.court_number ?? "");
  const [isYounger,      setIsYounger]      = useState(base?.is_younger !== false ? true : false);
  const [gameFormat,     setGameFormat]     = useState(base?.game_format ?? 7);
  const [isDoubles,      setIsDoubles]      = useState(base?.is_doubles ?? true);
  const [firstServer,    setFirstServer]    = useState(base?.first_server ?? null);
  const [aClub,  setAClub]  = useState(aBase?.club_name ?? "");
  const [aP1,    setAP1]    = useState(aBase?.player_name ?? "");
  const [aP2,    setAP2]    = useState(aBase2?.player_name ?? "");
  const [bClub,  setBClub]  = useState(bBase?.club_name ?? "");
  const [bP1,    setBP1]    = useState(bBase?.player_name ?? "");
  const [bP2,    setBP2]    = useState(bBase2?.player_name ?? "");

  // 団体戦
  const [isTeam,       setIsTeam]       = useState(base?.is_team === true);
  const [finishEarly,  setFinishEarly]  = useState(base?.finish_early !== false);
  const [teamAP1_2,    setTeamAP1_2]    = useState("");
  const [teamAP2_2,    setTeamAP2_2]    = useState("");
  const [teamBP1_2,    setTeamBP1_2]    = useState("");
  const [teamBP2_2,    setTeamBP2_2]    = useState("");
  const [teamAP1_3,    setTeamAP1_3]    = useState("");
  const [teamAP2_3,    setTeamAP2_3]    = useState("");
  const [teamBP1_3,    setTeamBP1_3]    = useState("");
  const [teamBP2_3,    setTeamBP2_3]    = useState("");

  const isScheduledEdit = editing?.status === "scheduled";
  const canSave1 = aP1.trim() && aP2.trim() && bP1.trim() && bP2.trim() && isYounger !== null;
  const canSave = isTeam
    ? canSave1 && teamAP1_2.trim() && teamAP2_2.trim() && teamBP1_2.trim() && teamBP2_2.trim() && teamAP1_3.trim() && teamAP2_3.trim() && teamBP1_3.trim() && teamBP2_3.trim()
    : aP1.trim() && (!isDoubles || aP2.trim()) && bP1.trim() && (!isDoubles || bP2.trim()) && isYounger !== null;

  const [saving, setSaving] = useState(false);
  const [scheduledId, setScheduledId] = useState(editing?.status==="scheduled" ? editing.id : null); // 予定登録済みのID
  const [serveSelectForSave, setServeSelectForSave] = useState(null);

  // ★選手マスター（同じ学校のメンバーで共有）を読み込み、入力時にチップで選べるようにする
  const [roster, setRoster] = useState([]);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);
  const ownRoster = roster.filter(p => p.is_own_team !== false);
  const oppRosterBase = roster.filter(p => p.is_own_team === false);
  // 同校対決：相手チームが自チームと同じ学校名の場合、自チームの選手もチップに表示
  const isSameSchool = aClub && bClub && aClub.trim() === bClub.trim();
  const oppRoster = isSameSchool
    ? [...ownRoster, ...oppRosterBase.filter(p => p.team_name === bClub)]
    : oppRosterBase;

  // ★学校名の候補一覧（誤入力防止）
  const [schools, setSchools] = useState([]);
  useEffect(() => { getKnownSchools().then(setSchools); }, []);

  // ★会場名の候補一覧
  const [venues, setVenues] = useState([]);
  useEffect(() => { getKnownVenues().then(setVenues); }, []);

  // ★チーム名/学校名の都道府県絞り込み（自チーム・相手チームそれぞれ独立）
  const [aClubPref, setAClubPref] = useState("");
  const [bClubPref, setBClubPref] = useState("");

  // ★新規作成時（編集・コピーではない場合）は、自チームの学校名をプロフィールの学校で初期化する
  useEffect(() => {
    if (base) return; // 編集・コピー時は既存のチーム名をそのまま使う
    (async () => {
      const profile = await getMyProfile();
      if (!profile?.school_id) return;
      const allSchools = await getSchools();
      const mine = allSchools.find(s => s.id === profile.school_id);
      if (mine) setAClub(prev => prev || mine.name);
    })();
  }, []);

  // 自チーム選手の入力チェック
  const canSchedule = isTeam
    ? bClub.trim() && isYounger !== null  // 団体戦：相手校名だけでOK
    : aP1.trim() && (!isDoubles || aP2.trim()) && isYounger !== null;

  async function handleSchedule() {
    // 2回目以降は確認ポップアップ
    if (scheduledId) {
      if (!window.confirm("予定情報を更新しますか？")) return;
    }
    setSaving(true);
    try {
      if (isTeam) {
        // 団体戦：team_matchesに登録。選手なしでもOK
        const tmId = scheduledId || uid();
        // 3試合分のmatchを作成（選手は空でもOK）
        const makeEmptyMatch = async (slotRound) => {
          const mid = uid();
          const m = {
            id:mid, created_by:"me",
            match_date:matchDate, venue, tournament_name:tournamentName, round:slotRound,
            match_type:matchType, game_format:gameFormat, is_doubles:true, first_server:null,
            status:"scheduled", match_score_a:0, match_score_b:0, memo:"",
            court_number:courtNumber||null, is_younger:isYounger, players:[], games:[],
          };
          await saveMatch(m);
          return mid;
        };
        // 既存のmatch_idがあればそのまま使い、なければ新規作成
        const existingList = scheduledId ? await getTeamMatches().then(list=>list.find(t=>t.id===tmId)) : null;
        const mid1 = existingList?.match_id_1 || await makeEmptyMatch("団体戦1番手");
        const mid2 = existingList?.match_id_2 || await makeEmptyMatch("団体戦2番手");
        const mid3 = existingList?.match_id_3 || await makeEmptyMatch("団体戦3番手");
        await saveTeamMatch({
          id: tmId,
          match_date: matchDate,
          tournament_name: tournamentName || null,
          venue: venue || null,
          opponent_name: bClub.trim(),
          format: "best_of_3",
          finish_early: finishEarly,
          match_id_1: mid1,
          match_id_2: mid2,
          match_id_3: mid3,
        });
        setScheduledId(tmId);
        onScheduled && onScheduled();
        return;
      }
      const mid = scheduledId || uid();
      const players = [
        { id:uid(), match_id:mid, team:"A", player_name:aP1.trim(), club_name:aClub.trim(), position:null, order_num:1 },
        ...(isDoubles && aP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:aP2.trim(), club_name:aClub.trim(), position:null, order_num:2 }] : []),
        ...(bP1.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:bP1.trim(), club_name:bClub.trim(), position:null, order_num:1 }] : []),
        ...(isDoubles && bP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:bP2.trim(), club_name:bClub.trim(), position:null, order_num:2 }] : []),
      ];
      const match = {
        id:mid, created_by:"me",
        match_date:matchDate, venue, tournament_name:tournamentName, round,
        match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server:firstServer,
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
    if (editing) { handleSave(null); return; } // 編集時はサーブ選択不要
    // 自チームと相手のラベルを作成
    const aLabel = [aP1.trim(), isDoubles ? aP2.trim() : ""].filter(Boolean).join("/") || "自チーム";
    const bLabel = [bP1.trim(), isDoubles ? bP2.trim() : ""].filter(Boolean).join("/") || "相手チーム";
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
          ...(editing.status === "scheduled" ? { game_format:gameFormat, is_doubles:isDoubles, first_server:firstServer, is_younger:isYounger } : { is_younger:isYounger }),
        };
        await saveMatch(updated);
        onSave(editing.id);
        return;
      }

      // 新規作成 or コピー作成
      if (isTeam) {
        // 団体戦：3試合分を作成してteam_matchesに登録
        const makeMatch = async (ap1, ap2, bp1, bp2, slotRound) => {
          const mid = uid();
          const players = [
            { id:uid(), match_id:mid, team:"A", player_name:ap1.trim(), club_name:aClub.trim(), position:null, order_num:1 },
            { id:uid(), match_id:mid, team:"A", player_name:ap2.trim(), club_name:aClub.trim(), position:null, order_num:2 },
            { id:uid(), match_id:mid, team:"B", player_name:bp1.trim(), club_name:bClub.trim(), position:null, order_num:1 },
            { id:uid(), match_id:mid, team:"B", player_name:bp2.trim(), club_name:bClub.trim(), position:null, order_num:2 },
          ];
          const m = {
            id:mid, created_by:"me",
            match_date:matchDate, venue, tournament_name:tournamentName, round:slotRound,
            match_type:matchType, game_format:gameFormat, is_doubles:true, first_server:null,
            status:"scheduled", match_score_a:0, match_score_b:0, memo:"", court_number:courtNumber||null, is_younger:isYounger, players, games:[],
          };
          await saveMatch(m);
          return mid;
        };
        const [mid1, mid2, mid3] = await Promise.all([
          makeMatch(aP1, aP2, bP1, bP2, "団体戦1番手"),
          makeMatch(teamAP1_2, teamAP2_2, teamBP1_2, teamBP2_2, "団体戦2番手"),
          makeMatch(teamAP1_3, teamAP2_3, teamBP1_3, teamBP2_3, "団体戦3番手"),
        ]);
        const tmId = uid();
        await saveTeamMatch({
          id: tmId,
          match_date: matchDate,
          tournament_name: tournamentName || null,
          venue: venue || null,
          opponent_name: bClub.trim(),
          format: "best_of_3",
          finish_early: finishEarly,
          match_id_1: mid1,
          match_id_2: mid2,
          match_id_3: mid3,
        });
        onSave(mid1, tmId);
        return;
      }

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
        match_type:matchType, game_format:gameFormat, is_doubles:isDoubles, first_server:selectedServer || firstServer || "A",
        status:"active", match_score_a:0, match_score_b:0, memo:"", court_number:courtNumber||null, is_younger:isYounger, players, games:[],
      };
      await saveMatch(match);
      // 選手マスターに自動登録（直接入力された選手のみ。マスター未登録の場合）
      const autoRegisterTasks = [
        autoRegisterPlayerToRoster(aP1.trim(), aClub.trim(), true),
        ...(isDoubles && aP2.trim() ? [autoRegisterPlayerToRoster(aP2.trim(), aClub.trim(), true)] : []),
        autoRegisterPlayerToRoster(bP1.trim(), bClub.trim(), false),
        ...(isDoubles && bP2.trim() ? [autoRegisterPlayerToRoster(bP2.trim(), bClub.trim(), false)] : []),
      ];
      await Promise.all(autoRegisterTasks);
      onSave(mid);
    } catch (e) {
      alert("保存エラー: " + JSON.stringify({msg: e?.message, code: e?.code, details: e?.details, hint: e?.hint}));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onCancel}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{editing?"試合情報を編集":source?"試合をコピー":"新規試合"}</span>
        </div>
      </div>
      {source && (
        <div style={{ background:"#fff8e6",borderBottom:"1px solid #f5d99b",padding:"10px 14px",fontSize:12,color:"#7a5800" }}>
          📋 「{source.tournament_name || "前の試合"}」の情報をコピーしました。内容を確認・変更してください（スコアはコピーされません）。
        </div>
      )}
      {locked && (
        <div style={{ background:"#e3f2fd",borderBottom:"1px solid #90caf9",padding:"10px 14px",fontSize:12,color:"#1565c0" }}>
          ✏️ 試合情報・選手名を編集できます。ゲーム数・種目・サーブ順は試合開始後のため変更できません。
        </div>
      )}
      <div style={{ padding:14 }}>

        <FormSec title="試合情報">
          <FormRow label="試合日">
            <input type="date" style={S.inp} value={matchDate} onChange={e => setMatchDate(e.target.value)}/>
          </FormRow>
          <FormRow label="大会名">
            <input style={S.inp} placeholder="例：○○中学校選手権" value={tournamentName} onChange={e => setTournamentName(e.target.value)}/>
          </FormRow>
          <FormRow label="試合の種別">
            <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
              {MATCH_TYPES.map(({key,label}) => (
                <button key={key} style={S.togBtn(matchType===key)} onClick={() => setMatchType(key)}>{label}</button>
              ))}
            </div>
          </FormRow>
          <FormRow label="若番 / 遅番（必須）">
            <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>自チームはトーナメント表のどちら側ですか？</div>
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ ...S.togBtn(isYounger===true, C.navy), flex:1, padding:"10px 4px" }} onClick={()=>setIsYounger(true)}>
                <div style={{ fontSize:13, fontWeight:700 }}>若番</div>
                <div style={{ fontSize:10, opacity:0.8 }}>スコア左側</div>
              </button>
              <button style={{ ...S.togBtn(isYounger===false, C.navy), flex:1, padding:"10px 4px" }} onClick={()=>setIsYounger(false)}>
                <div style={{ fontSize:13, fontWeight:700 }}>遅番</div>
                <div style={{ fontSize:10, opacity:0.8 }}>スコア右側</div>
              </button>
            </div>
          </FormRow>
          <FormRow label="場所 / 会場名">
            <VenueField value={venue} onChange={setVenue} venues={venues} />
          </FormRow>
          <FormRow label="コート番号（任意）">
            <input style={S.inp} placeholder="例：3番コート" value={courtNumber} onChange={e => setCourtNumber(e.target.value)}/>
          </FormRow>
          <FormRow label="何回戦">
            <input style={S.inp} placeholder="例：準々決勝" value={round} onChange={e => setRound(e.target.value)}/>
          </FormRow>
        </FormSec>

        <FormSec title={locked ? "形式設定（試合開始後は変更不可）" : "形式設定"}>
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
          {!locked && (
            <FormRow label="個人戦 / 団体戦">
              <div style={{ display:"flex",gap:8 }}>
                <button style={{ ...S.togBtn(!isTeam, C.navy), flex:1 }} onClick={()=>setIsTeam(false)}>個人戦</button>
                <button style={{ ...S.togBtn(isTeam, C.navy), flex:1 }} onClick={()=>{ setIsTeam(true); setIsDoubles(true); }}>団体戦</button>
              </div>
            </FormRow>
          )}
          {isTeam && !locked && (
            <>
              <FormRow label="試合終了タイミング">
                <div style={{ display:"flex",gap:8 }}>
                  <button style={{ ...S.togBtn(finishEarly, C.navy), flex:1 }} onClick={()=>setFinishEarly(true)}>
                    <div style={{ fontSize:13,fontWeight:700 }}>2勝で終了</div>
                  </button>
                  <button style={{ ...S.togBtn(!finishEarly, C.navy), flex:1 }} onClick={()=>setFinishEarly(false)}>
                    <div style={{ fontSize:13,fontWeight:700 }}>3試合全部</div>
                  </button>
                </div>
              </FormRow>
              <FormRow label="相手校名">
                <SchoolField value={bClub} onChange={v=>{ setBClub(v); }} schools={schools} placeholder="例：久留米筑水" prefFilter={bClubPref} />
              </FormRow>
            </>
          )}
        </FormSec>

        {!isTeam && <FormSec title="自チーム (A)">
          <FormRow label="チーム名 / 学校名" labelRight={<PrefMiniFilter value={aClubPref} onChange={setAClubPref} options={knownPrefsFrom(schools)} />}>
            <SchoolField value={aClub} onChange={setAClub} schools={schools} placeholder="例：○○中学校" prefFilter={aClubPref} />
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={aP1} onChange={e => setAP1(e.target.value)}/>
            {ownRoster.length>0 && (
              <div style={{ marginTop:6 }}>
                {ownRoster.map(p=>(
                  <span key={p.id} style={S.chip(aP1===p.player_name)} onClick={()=>setAP1(p.player_name)}>{p.player_name}</span>
                ))}
              </div>
            )}
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={aP2} onChange={e => setAP2(e.target.value)}/>
              {ownRoster.length>0 && (
                <div style={{ marginTop:6 }}>
                  {ownRoster.map(p=>(
                    <span key={p.id} style={S.chip(aP2===p.player_name)} onClick={()=>setAP2(p.player_name)}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
          )}
          {ownRoster.length===0 && (
            <div style={{ padding:"0 14px 12px",fontSize:11,color:C.textSec }}>
              マスター画面の「👥 選手マスター」(自チーム)から選手を登録すると、ここで選んで入力できるようになります。
            </div>
          )}
        </FormSec>}

        {!isTeam && (
          <FormSec title="相手チーム (B)">
            <FormRow label="チーム名 / 学校名" labelRight={<PrefMiniFilter value={bClubPref} onChange={setBClubPref} options={knownPrefsFrom(schools)} />}>
              <SchoolField value={bClub} onChange={setBClub} schools={schools} placeholder="例：相手チーム名" prefFilter={bClubPref} />
            </FormRow>
            <FormRow label={isDoubles ? "選手1" : "選手名"}>
              <input style={S.inp} placeholder="選手名" value={bP1} onChange={e => setBP1(e.target.value)}/>
              {oppRoster.filter(p => !bClub || p.team_name === bClub).length>0 && (
                <div style={{ marginTop:6 }}>
                  {oppRoster.filter(p => !bClub || p.team_name === bClub).map(p=>(
                    <span key={p.id} style={S.chip(bP1===p.player_name)} onClick={()=>{ setBP1(p.player_name); if (!bClub && p.team_name) setBClub(p.team_name); }}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
            {isDoubles && (
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={bP2} onChange={e => setBP2(e.target.value)}/>
                {oppRoster.filter(p => !bClub || p.team_name === bClub).length>0 && (
                  <div style={{ marginTop:6 }}>
                    {oppRoster.filter(p => !bClub || p.team_name === bClub).map(p=>(
                      <span key={p.id} style={S.chip(bP2===p.player_name)} onClick={()=>{ setBP2(p.player_name); if (!bClub && p.team_name) setBClub(p.team_name); }}>{p.player_name}</span>
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
        )}
        {isTeam && (
          <>
            {/* 1番手 */}
            <FormSec title="1番手">
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:4 }}>自チーム</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={aP1} onChange={e=>setAP1(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(aP1===p.player_name)} onClick={()=>setAP1(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={aP2} onChange={e=>setAP2(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(aP2===p.player_name)} onClick={()=>setAP2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,margin:"8px 0 4px" }}>相手チーム（{bClub||"相手校"}）</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={bP1} onChange={e=>setBP1(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(bP1===p.player_name)} onClick={()=>setBP1(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={bP2} onChange={e=>setBP2(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(bP2===p.player_name)} onClick={()=>setBP2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
            </FormSec>
            {/* 2番手 */}
            <FormSec title="2番手">
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:4 }}>自チーム</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={teamAP1_2} onChange={e=>setTeamAP1_2(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(teamAP1_2===p.player_name)} onClick={()=>setTeamAP1_2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={teamAP2_2} onChange={e=>setTeamAP2_2(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(teamAP2_2===p.player_name)} onClick={()=>setTeamAP2_2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,margin:"8px 0 4px" }}>相手チーム（{bClub||"相手校"}）</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={teamBP1_2} onChange={e=>setTeamBP1_2(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(teamBP1_2===p.player_name)} onClick={()=>setTeamBP1_2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={teamBP2_2} onChange={e=>setTeamBP2_2(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(teamBP2_2===p.player_name)} onClick={()=>setTeamBP2_2(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
            </FormSec>
            {/* 3番手 */}
            <FormSec title="3番手">
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:4 }}>自チーム</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={teamAP1_3} onChange={e=>setTeamAP1_3(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(teamAP1_3===p.player_name)} onClick={()=>setTeamAP1_3(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={teamAP2_3} onChange={e=>setTeamAP2_3(e.target.value)}/>
                {ownRoster.length>0 && <div style={{ marginTop:6 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(teamAP2_3===p.player_name)} onClick={()=>setTeamAP2_3(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <div style={{ fontSize:12,fontWeight:700,color:C.textSec,margin:"8px 0 4px" }}>相手チーム（{bClub||"相手校"}）</div>
              <FormRow label="選手1">
                <input style={S.inp} placeholder="選手名" value={teamBP1_3} onChange={e=>setTeamBP1_3(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(teamBP1_3===p.player_name)} onClick={()=>setTeamBP1_3(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
              <FormRow label="選手2（ペア）">
                <input style={S.inp} placeholder="選手名" value={teamBP2_3} onChange={e=>setTeamBP2_3(e.target.value)}/>
                {oppRoster.filter(p=>!bClub||p.team_name===bClub).length>0 && <div style={{ marginTop:6 }}>{oppRoster.filter(p=>!bClub||p.team_name===bClub).map(p=>(<span key={p.id} style={S.chip(teamBP2_3===p.player_name)} onClick={()=>setTeamBP2_3(p.player_name)}>{p.player_name}</span>))}</div>}
              </FormRow>
            </FormSec>
          </>
        )}

        {!editing && (
          <button
            style={{ ...S.btn(canSchedule ? "linear-gradient(135deg,#7b1fa2,#9c27b0)" : C.border, canSchedule ? C.white : C.textSec), marginTop:4, marginBottom:8 }}
            disabled={!canSchedule || saving}
            onClick={handleSchedule}
          >
            {saving ? "登録中..." : scheduledId ? "📅 試合予定を更新する" : "📅 試合予定として登録する"}
          </button>
        )}
        <button
          style={{ ...S.btn((canSave&&!saving) ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border, (canSave&&!saving) ? C.white : C.textSec), marginTop:4 }}
          disabled={!canSave || saving}
          onClick={editing ? ()=>handleSave(null) : handleSaveWithServeSelect}
        >
          {saving ? "保存中..." : (editing ? "保存する 💾" : "試合を開始する 🎾")}
        </button>
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
                  style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?C.teamA:C.teamB}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?C.teamA:C.teamB }}
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
function ScoreRecord({ matchId, onBack, onEdit, onNavigate }) {
  const [initialMatch, setInitialMatch] = useState(null);
  const [loadKey, setLoadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [viewOnly, setViewOnly] = useState(false); // 観戦モード

  const handleRefresh = async () => {
    setRefreshing(true);
    const m = await getMatch(matchId);
    setInitialMatch(m);
    setRefreshing(false);
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
        // 作成者でなければ観戦モード
        if (m && user && m.created_by !== user.id) setViewOnly(true);
      } catch(e) {
        if (!cancelled) alert("試合読み込みエラー: " + JSON.stringify({msg: e?.message, code: e?.code, details: e?.details}));
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
      />
    </ErrorBoundary>
  );
}

function ScoreRecordInner({ initialMatch, onBack, onEdit, onReload, onRefresh, refreshing, onNavigate, viewOnly }) {
  const [match,  setMatch]  = useState(initialMatch);
  const [tab,    setTab]    = useState(viewOnly ? "score" : "record");
  const [fault,  setFault]  = useState(0);
  const [modal,  setModal]  = useState(null);
  const [serveSelectModal, setServeSelectModal] = useState(false); // サーブ選択モーダル
  // 4段階選択状態
  const [selPlay,   setSelPlay]   = useState(null);   // プレイ内容
  const [selSide,   setSelSide]   = useState(null);   // フォア / バック
  const [selResult, setSelResult] = useState(null);   // 結果
  const [selPlayer, setSelPlayer] = useState(null);   // 選手（表示名・記録用）
  const [selPlayerId, setSelPlayerId] = useState(null); // 選手（チップ選択状態の判定用・一意ID）
  const [correctMode, setCorrectMode] = useState(false); // 試合終了後のスコア修正モード
  const [editingPoint, setEditingPoint] = useState(null); // 修正中のポイント { gameId, point }
  const [addingPoint, setAddingPoint] = useState(null); // 追加位置 { gameId, atIndex }
  const [memoDraft, setMemoDraft] = useState(initialMatch.memo || ""); // 試合メモ（下書き）
  const [memoSaved, setMemoSaved] = useState(true); // メモが保存済みかどうか

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
  const serverLabel = curServer==="A" ? match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/") : match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
  const teamALabel = match.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/");
  const teamBLabel = match.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/");
  // 若番=自チーム左、遅番=自チーム右
  const isYounger = match.is_younger === true;
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
  // 自チーム=緑、相手=オレンジ（左右に関わらず固定）
  const ownColor  = "#2ecc71";  // 緑
  const oppColor  = "#f97316";  // オレンジ
  const leftColor  = ownColor;  // 左=常に自チーム
  const rightColor = oppColor;  // 右=常に相手

  function resetSel(){ setSelPlay(null); setSelSide(null); setSelResult(null); setSelPlayer(null); setSelPlayerId(null); }

  function startNewGame(base=match, overrideServer=null){
    const server = overrideServer || base.first_server;
    if (!server) {
      setServeSelectModal(true);
      return;
    }
    base = { ...base, first_server: server };
    const num=base.games.length+1;
    const isFin=isFinalGame(base.game_format,base.match_score_a,base.match_score_b);
    const srv=gameServer(base.first_server||server,num);
    const g={id:uid(),match_id:base.id,game_number:num,server_team:srv,is_final:isFin,score_a:0,score_b:0,winner_team:null,points:[],faults:[]};
    persist({...base,games:[...base.games,g]});
  }

  function addPoint(team){
    if(!currentGame) return;
    const cg=currentGame;
    const newA=team==="A"?cg.score_a+1:cg.score_a;
    const newB=team==="B"?cg.score_b+1:cg.score_b;
    const isWin = selResult ? isWinnerResult(selResult) : null;
    const pt={
      id:uid(),game_id:cg.id,match_id:match.id,
      point_number:nonFaultPts.length+1,
      scoring_team:team,
      player_name:selPlayer??null,
      play_type:selPlay??null,
      side_type:selSide??null,
      result_type:selResult??null,
      is_winner:isWin,
      score_a_after:newA, score_b_after:newB,
    };
    const updG={...cg,points:[...cg.points,pt],score_a:newA,score_b:newB};
    const gWin=cg.is_final?checkFinalWinner(newA,newB):checkNormalWinner(newA,newB);
    if(gWin) updG.winner_team=gWin;
    const newMA=match.match_score_a+(gWin==="A"?1:0);
    const newMB=match.match_score_b+(gWin==="B"?1:0);
    const updM={...match,games:match.games.map(g=>g.id===cg.id?updG:g),match_score_a:newMA,match_score_b:newMB};
    resetSel(); setFault(0);
    if(gWin){
      if(newMA>=winGames||newMB>=winGames){ persist({...updM,status:"finished"}); }
      else { persist(updM); setModal({type:"gameOver",winner:gWin,num:cg.game_number,sA:newMA,sB:newMB}); }
    } else { persist(updM); }
  }

  function handleFault(){
    if(!currentGame) return;
    if(fault===0){
      const cg=currentGame;
      const f={id:uid(),game_id:cg.id,match_id:match.id,fault_number:(cg.faults?.length??0)+1,server_team:curServer,player_name:selPlayer??null,score_a_at:cg.score_a,score_b_at:cg.score_b};
      persist({...match,games:match.games.map(g=>g.id===cg.id?{...cg,faults:[...(cg.faults??[]),f]}:g)});
      setFault(1);
    } else {
      setFault(0);
      addPoint(curServer==="A"?"B":"A");
    }
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

  return (
    <div style={S.page}>
      {/* スコアボードヘッダー */}
      <div style={{ background:`linear-gradient(135deg,${C.navy},${C.navyMid})`, padding:"10px 14px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <div style={{ textAlign:"center" }}>
            {match.tournament_name&&<div style={{ fontSize:11,color:"rgba(255,255,255,0.8)",fontWeight:700 }}>{match.tournament_name}{match.round?` · ${match.round}`:""}</div>}
            <div style={{ fontSize:10,color:"rgba(255,255,255,0.5)" }}>{fmtDate(match.match_date)}{match.venue?` · ${match.venue}`:""}{match.court_number?` · ${match.court_number}`:""} · {match.game_format}Gマッチ</div>
          </div>
          <div style={{ display:"flex", gap:6 }}>
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
            <div key={g.id} style={{ padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:g.winner_team===leftTeam?ownColor:g.winner_team===rightTeam?oppColor:"rgba(255,255,255,0.2)",color:C.white }}>
              {g.is_final?"🔥":""}G{g.game_number}: {leftScore(g)}-{rightScore(g)}
            </div>
          ))}
        </div>
        {currentGameIsFinal&&currentGame&&<div style={{ textAlign:"center",marginTop:6 }}><span style={{ fontSize:10,fontWeight:800,color:C.white,background:"#dc2626",padding:"2px 10px",borderRadius:20 }}>🔥 ファイナルゲーム（7点先取）</span></div>}
      </div>

      {/* タブ */}
      {viewOnly && (
        <div style={{ background:"#e3f2fd", borderBottom:"1px solid #90caf9", padding:"8px 14px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:12, color:"#1565c0", fontWeight:700 }}>👁 観戦モード（スコア閲覧のみ）</span>
          <button
            style={{ background:"#1565c0", border:"none", borderRadius:8, color:"#fff", fontSize:12, padding:"5px 10px", cursor:"pointer", opacity: refreshing ? 0.5 : 1 }}
            onClick={onRefresh} disabled={refreshing}
          >{refreshing ? "更新中..." : "🔄 最新に更新"}</button>
        </div>
      )}
      <div style={{ display:"flex",background:C.white,borderBottom:`1px solid ${C.border}` }}>
        {(viewOnly ? [["score","スコア"],["stats","スタッツ"]] : [["record","記録"],["score","スコア"],["stats","スタッツ"]]).map(([v,l])=>(
          <button key={v} style={{ flex:1,padding:11,border:"none",cursor:"pointer",background:"transparent",fontWeight:tab===v?700:400,fontSize:14,color:tab===v?C.accent:C.textSec,borderBottom:tab===v?`3px solid ${C.accent}`:"3px solid transparent" }} onClick={()=>setTab(v)}>{l}</button>
        ))}
      </div>

      {/* 記録タブ */}
      {tab==="record"&&!viewOnly&&(
        <div style={{ padding:"10px 12px 20px" }}>
          {match.games.length===0&&match.status!=="finished"&&(
            <div style={{ textAlign:"center",padding:"40px 0" }}>
              <div style={{ fontSize:36,marginBottom:12 }}>🎾</div>
              <p style={{ color:C.textSec,marginBottom:8 }}>第1ゲームを開始してください</p>
              <p style={{ fontSize:13,color:match.first_server==="A"?C.teamA:C.teamB,fontWeight:700,marginBottom:20 }}>最初のサーブ: {match.first_server==="A"?teamALabel:teamBLabel}</p>
              <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>startNewGame()}>第1ゲーム開始</button>
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
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:ownColor,textAlign:"center" }}>{leftLabel}</span>
                  <span style={{ width:74,fontSize:10,fontWeight:700,color:oppColor,textAlign:"center" }}>{rightLabel}</span>
                </div>
                {match.games.map(g=>(
                  <div key={g.id} style={{ display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:"1px solid "+C.border }}>
                    <span style={{ fontSize:12,color:C.textSec,width:46 }}>{g.is_final?"🔥":""}G{g.game_number}</span>
                    <span style={{ flex:1,fontSize:15,fontWeight:700,textAlign:"center" }}>
                      <span style={{ color:g.winner_team===leftTeam?ownColor:C.textSec }}>{leftScore(g)}</span>
                      <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                      <span style={{ color:g.winner_team===rightTeam?oppColor:C.textSec }}>{rightScore(g)}</span>
                    </span>
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team===leftTeam?"🏆":""}</span>
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team===rightTeam?"🏆":""}</span>
                  </div>
                ))}
                <div style={{ display:"flex",alignItems:"center",padding:"12px 14px",background:C.accentL }}>
                  <span style={{ fontSize:12,fontWeight:700,color:C.navy,width:46 }}>合計</span>
                  <span style={{ flex:1,fontSize:20,fontWeight:900,textAlign:"center" }}>
                    <span style={{ color:leftMatchScore>rightMatchScore?ownColor:C.textSec }}>{leftMatchScore}</span>
                    <span style={{ color:C.textSec,margin:"0 8px" }}>-</span>
                    <span style={{ color:rightMatchScore>leftMatchScore?oppColor:C.textSec }}>{rightMatchScore}</span>
                  </span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{leftMatchScore>rightMatchScore?"🏆":""}</span>
                  <span style={{ width:74,textAlign:"center",fontSize:16 }}>{rightMatchScore>leftMatchScore?"🏆":""}</span>
                </div>
              </div>
              {/* 試合メモ */}
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
              {/* ボタン群 */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8 }}>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("stats")}>📊 スタッツを見る</button>
                <button style={{ ...S.btn(C.navyMid),fontSize:13 }} onClick={()=>setTab("score")}>📋 スコアを見る</button>
              </div>
              <button style={{ ...S.btn("#fff"),color:C.navy,border:"1px solid "+C.border,marginBottom:8 }} onClick={()=>onEdit&&onEdit(match.id)}>✏️ 試合情報を編集</button>
              <button style={{ ...S.btn("#fff"),color:C.orange,border:"1px solid "+C.orange,marginBottom:8 }} onClick={()=>setCorrectMode(true)}>✏️ スコアを修正</button>
              <button style={{ ...S.btn("#06c755"),marginBottom:8 }} onClick={()=>window.open("https://line.me/R/msg/text/?"+encodeURIComponent(buildLineText(match)),"_blank")}>💬 LINEで結果を共有</button>
              <button style={{ ...S.btn("linear-gradient(135deg,"+C.accent+",#00a066)") }} onClick={onBack}>← 試合一覧に戻る</button>
            </div>
          )}

          {match.status==="finished"&&correctMode&&(
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
              {/* フォルトカウントバー */}
              <div style={{ background:"#fff3e0",border:`1px solid #ffd699`,borderRadius:10,padding:"6px 12px",marginBottom:10,display:"flex",alignItems:"center",gap:8 }}>
                <span style={{ fontSize:11,fontWeight:700,color:"#e65100",flex:1 }}>🎾 {serverLabel} のサーブ</span>
                <span style={{ fontSize:10,color:"#666" }}>1st:</span>
                <div style={{ width:12,height:12,borderRadius:"50%",background:fault>=1?C.orange:C.border }}/>
                <div style={{ width:12,height:12,borderRadius:"50%",background:fault>=2?C.orange:C.border }}/>
                <button style={{ background:fault===1?"#dc2626":C.purple,color:C.white,border:"none",borderRadius:7,fontSize:11,fontWeight:700,padding:"4px 10px",cursor:"pointer" }} onClick={handleFault}>
                  {fault===1?"フォルト→DF":"フォルト"}
                </button>
              </div>

              {/* ★段階1: プレイ内容 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容（任意）</div>
                <div>
                  {PLAY_TYPES.map(p=>(
                    <span key={p.key} style={S.chip(selPlay===p.key)} onClick={()=>setSelPlay(selPlay===p.key?null:p.key)}>{p.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階2: フォア / バック */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>フォア / バック（任意）</div>
                <div>
                  {SIDE_TYPES.map(s=>(
                    <span key={s.key} style={S.chip(selSide===s.key)} onClick={()=>setSelSide(selSide===s.key?null:s.key)}>{s.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階3: 結果 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>結果（任意）</div>
                <div>
                  {RESULT_TYPES.map(r=>(
                    <span key={r.key} style={S.chip(selResult===r.key)} onClick={()=>setSelResult(selResult===r.key?null:r.key)}>{r.label}</span>
                  ))}
                </div>
              </div>

              {/* ★段階4: 選手 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:10 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>選手（任意）</div>
                <div>
                  {allPlayers.map(p=>(
                    <span
                      key={p.id}
                      style={S.chip(selPlayerId===p.id)}
                      onClick={()=>{ setSelPlayerId(selPlayerId===p.id?null:p.id); setSelPlayer(selPlayerId===p.id?null:p.name); }}
                    >{p.name}</span>
                  ))}
                </div>
              </div>

              {/* ★得点ボタン（◯✕→「得点」表記に変更） */}
              <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>どちらが得点しましたか？</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                {/* 左ボタン：若番=自チーム(緑)、遅番=相手(オレンジ) */}
                <button style={{ height:70,background:isYounger?ownColor:oppColor,color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(46,204,113,0.35)":"0 3px 10px rgba(249,115,22,0.35)" }} onClick={()=>addPoint(leftTeam)}>
                  <span style={{ fontSize:22 }}>得点</span>
                  <span style={{ fontSize:11,opacity:0.9 }}>{leftClub||"自チーム"}</span>
                </button>
                {/* 右ボタン：若番=相手(オレンジ)、遅番=自チーム(緑) */}
                <button style={{ height:70,background:isYounger?oppColor:ownColor,color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(249,115,22,0.35)":"0 3px 10px rgba(46,204,113,0.35)" }} onClick={()=>addPoint(rightTeam)}>
                  <span style={{ fontSize:22 }}>得点</span>
                  <span style={{ fontSize:11,opacity:0.9 }}>{rightClub||"相手"}</span>
                </button>
              </div>
              <button style={{ width:"100%",padding:11,background:"#dbeafe",color:"#1565c0",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={undo}>↩ 1つ前に戻す</button>

              {/* 直近記録 */}
              {currentGame.points.length>0&&(
                <div style={{ marginTop:12 }}>
                  <div style={{ fontSize:11,color:C.textSec,fontWeight:700,marginBottom:6 }}>直近の記録</div>
                  {[...currentGame.points].reverse().slice(0,5).map(pt=>(
                    <div key={pt.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:C.white,borderRadius:8,marginBottom:4,borderLeft:`4px solid ${pt.scoring_team==="A"?C.accent:C.orange}` }}>
                      <span style={{ fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:20,background:pt.scoring_team==="A"?C.accentL:C.redL,color:pt.scoring_team==="A"?C.accent:C.red,whiteSpace:"nowrap" }}>
                        {pt.scoring_team==="A"?"A 得点":"B 得点"}
                      </span>
                      <span style={{ fontSize:11,flex:1,color:C.text }}>
                        {[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):null,pt.side_type?getSideLabel(pt.side_type):null,pt.result_type?getResultLabel(pt.result_type):null].filter(Boolean).join(" · ")||"—"}
                      </span>
                      <span style={{ fontSize:11,color:C.textSec,whiteSpace:"nowrap" }}>{pt.score_a_after}-{pt.score_b_after}</span>
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
              <div style={{ padding:"8px 12px",background:g.winner_team==="A"?C.teamA:g.winner_team==="B"?C.teamB:C.accent,color:C.white,display:"flex",justifyContent:"space-between" }}>
                <span style={{ fontWeight:700,fontSize:13 }}>{g.is_final?"🔥":""}第{g.game_number}ゲーム</span>
                <span style={{ fontWeight:700 }}>{g.score_a} - {g.score_b}</span>
              </div>
              <div style={{ padding:"10px 12px" }}>
                <div style={{ display:"flex",gap:3,flexWrap:"wrap",marginBottom:8 }}>
                  {g.points.map(pt=>(
                    <div key={pt.id} title={[pt.player_name,pt.play_type?getPlayLabel(pt.play_type):"",pt.side_type?getSideLabel(pt.side_type):"",pt.result_type?getResultLabel(pt.result_type):""].filter(Boolean).join(" ")} style={{ width:22,height:22,borderRadius:5,background:pt.scoring_team==="A"?C.teamA:C.teamB,display:"flex",alignItems:"center",justifyContent:"center",cursor:"default" }}>
                      <span style={{ fontSize:9,color:C.white,fontWeight:700 }}>{pt.scoring_team}</span>
                    </div>
                  ))}
                </div>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ borderCollapse:"collapse",minWidth:280,fontSize:10 }}>
                    <tbody>
                      {[["A",teamALabel],["B",teamBLabel]].map(([team,name])=>(
                        <tr key={team}>
                          <td style={{ fontSize:10,color:team==="A"?C.teamA:C.teamB,fontWeight:700,paddingRight:8,whiteSpace:"nowrap" }}>{name}</td>
                          {g.points.map((pt,i)=>(
                            <td key={i} style={{ padding:"2px 4px",textAlign:"center",background:pt.scoring_team===team?(team==="A"?C.teamA+"18":C.teamB+"18"):"transparent",minWidth:28 }}>
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
            <div style={{ fontSize:28,fontWeight:900,margin:"10px 0" }}><span style={{ color:C.teamA }}>{modal.sA}</span><span style={{ color:C.textSec,margin:"0 8px" }}>-</span><span style={{ color:C.teamB }}>{modal.sB}</span></div>
            <button style={S.btn(`linear-gradient(135deg,${C.accent},#00a066)`)} onClick={()=>{setModal(null);startNewGame();}}>次のゲームへ</button>
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
                  style={{ flex:1, padding:"14px 8px", borderRadius:10, border:`2px solid ${team==="A"?C.teamA:C.teamB}`, background:"transparent", cursor:"pointer", fontSize:13, fontWeight:700, color:team==="A"?C.teamA:C.teamB }}
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

      <NavBar active="record" onNavigate={onNavigate}/>
    </div>
  );
}

// ============================================================
// スタッツタブ（★相手チームスタッツのバグ修正）
// ============================================================
function StatsTab({ match, onDownloadCsv, onShareLine }) {
  const [teamFilter, setTeamFilter] = useState("A");
  const stats    = calcPlayerStats(match);
  const comments = calcAutoComment(stats, teamFilter);
  // ★修正: teamFilterで絞る（Bも正しく表示）
  const filtered = stats.filter(s => s.team === teamFilter);

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
      {/* チーム比較 */}
      <div style={{ background:C.white,borderRadius:12,border:`1px solid ${C.border}`,padding:14,marginBottom:12 }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:12 }}>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamA }}>自チーム</span>
          <span style={{ fontSize:11,color:C.textSec }}>チーム比較</span>
          <span style={{ fontSize:12,fontWeight:700,color:C.teamB }}>相手チーム</span>
        </div>
        <Bar a={totalA} b={totalB} label="総ポイント"/>
        <Bar a={winA}   b={winB}   label="ウィナー"/>
        <Bar a={totalA-winA} b={totalB-winB} label="相手ミス"/>
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
        const topPlays = Object.entries(p.plays).sort((a,b)=>b[1]-a[1]).slice(0,4);
        return (
          <div key={`${p.team}__${p.player_name}`} style={{ ...S.card,marginBottom:10 }}>
            <div style={{ background:p.team==="A"?C.navyMid:C.navy,padding:"8px 12px",display:"flex",alignItems:"center",gap:8 }}>
              <div style={{ width:26,height:26,borderRadius:"50%",background:p.team==="A"?C.teamA:C.teamB,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:C.white }}>{p.player_name[0]}</div>
              <span style={{ fontSize:13,fontWeight:700,color:C.white,flex:1 }}>{p.player_name}</span>
              <span style={{ fontSize:10,color:"#8099cc" }}>計 {p.total}pt</span>
            </div>
            <div style={{ padding:12 }}>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10 }}>
                {[["得点",p.winners,C.accent],["ミス",p.errors,C.red],["得点率",p.total>0?`${Math.round(p.winners/p.total*100)}%`:"—",C.orange]].map(([l,v,c])=>(
                  <div key={l} style={{ background:`${c}11`,borderRadius:8,padding:"8px 4px",textAlign:"center" }}>
                    <div style={{ fontSize:18,fontWeight:700,color:c }}>{v}</div>
                    <div style={{ fontSize:9,color:C.textSec,fontWeight:700 }}>{l}</div>
                  </div>
                ))}
              </div>
              {/* プレイ内容内訳 */}
              {topPlays.length>0&&<div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容の内訳</div>}
              {topPlays.map(([k,n])=>{
                const isWin=p.results["winner"]>0||p.results["ace"]>0;
                return (
                  <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                    <span style={{ fontSize:10,color:C.textSec,width:80,flexShrink:0 }}>{k==="fault"?"1stフォルト":getPlayLabel(k)}</span>
                    <div style={{ flex:1,height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${Math.round(n/p.total*100)}%`,height:"100%",background:C.accent,borderRadius:3 }}/></div>
                    <span style={{ fontSize:11,fontWeight:700,color:C.navy,width:28,textAlign:"right" }}>{n}回</span>
                  </div>
                );
              })}
              {/* 結果内訳 */}
              {Object.keys(p.results).length>0&&(
                <>
                  <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6,marginTop:8 }}>結果の内訳</div>
                  {Object.entries(p.results).map(([k,n])=>{
                    const iw=isWinnerResult(k);
                    return (
                      <div key={k} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                        <span style={{ fontSize:10,color:C.textSec,width:80,flexShrink:0 }}>{getResultLabel(k)}</span>
                        <div style={{ flex:1,height:6,background:C.border,borderRadius:3 }}><div style={{ width:`${Math.round(n/(p.total||1)*100)}%`,height:"100%",background:iw===false?C.red:C.accent,borderRadius:3 }}/></div>
                        <span style={{ fontSize:11,fontWeight:700,color:C.navy,width:28,textAlign:"right" }}>{n}回</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* 自動コメント */}
      {comments.length>0&&(
        <div style={{ marginBottom:16 }}>
          {comments.map((c,i)=>(
            <div key={i} style={{ background:c.type==="strength"?C.accentL:c.type==="warning"?"#fff3cd":C.redL,border:`1px solid ${c.type==="strength"?C.accent:c.type==="warning"?"#f5a623":C.red}`,borderRadius:10,padding:"10px 12px",marginBottom:8 }}>
              <div style={{ fontSize:11,fontWeight:700,color:c.type==="strength"?C.accent:c.type==="warning"?"#7a5800":C.red,marginBottom:3 }}>{c.type==="strength"?"💪 強み":"⚠️ 課題"} — {c.player}</div>
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
  const [name, setName] = useState("");
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

  useEffect(() => { getSchools().then(setSchools); }, []);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);

  useEffect(() => {
    let cancelled = false;
    getMyProfile().then(p => {
      if (cancelled) return;
      if (p) {
        setName(p.name ?? "");
        setSchoolId(p.school_id ?? null);
        setPrefecture(p.prefecture ?? "東京都");
        setGenderCategory(p.gender_category ?? null);
        setCategory(p.category ?? null);
        setLinkedPlayerId(p.linked_player_id ?? null);
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    setErrorMsg("");
    if (!name.trim()) { setErrorMsg("お名前を入力してください"); return; }
    if (!schoolId) { setErrorMsg("学校名を選択してください"); return; }
    if (!genderCategory) { setErrorMsg("男子・女子・共通を選択してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    setSaving(true);
    try {
      await saveMyProfile({ name: name.trim(), school_id: schoolId, prefecture, gender_category: genderCategory, category, linked_player_id: linkedPlayerId });
      onSaved?.();
      onBack();
    } catch (e) {
      setErrorMsg(e.message || "保存に失敗しました");
    } finally {
      setSaving(false);
    }
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
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          {!forced && <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>}
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>プロフィール</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        {forced && (
          <div style={{ background:"#fff3e0",border:"1px solid #ffb74d",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#e65100",marginBottom:14 }}>
            ⚠️ 学校名・男子女子区分の設定が完了していないため、試合の閲覧・作成ができません。設定して保存してください。
          </div>
        )}
        <FormSec title="基本情報">
          <FormRow label="お名前">
            <input style={S.inp} value={name} onChange={e=>setName(e.target.value)} />
          </FormRow>
          <FormRow label="都道府県">
            <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>setPrefecture(e.target.value)}>
              {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </FormRow>
          <FormRow label="学校名またはチーム名" labelRight={<PrefMiniFilter value={schoolPrefFilter} onChange={setSchoolPrefFilter} options={knownPrefsFrom(schools)} />}>
            <SchoolIdSelect value={schoolId} onChange={setSchoolId} schools={schools} prefFilter={schoolPrefFilter} genderCategory={genderCategory} />
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
          <FormRow label="お子さん／ご自身の選手登録（任意）">
            {roster.length===0 ? (
              <div style={{ fontSize:12,color:C.textSec,padding:"6px 0" }}>選手マスターに登録がまだありません。先に「選手マスター」から登録してください。</div>
            ) : (
              <select
                style={{ ...S.inp, background:"transparent" }}
                value={linkedPlayerId || ""}
                onChange={e=>setLinkedPlayerId(e.target.value || null)}
              >
                <option value="">設定しない</option>
                {roster.map(p => <option key={p.id} value={p.id}>{p.player_name}</option>)}
              </select>
            )}
            <div style={{ fontSize:11,color:C.textSec,marginTop:4 }}>設定すると、ホーム画面でその選手の戦績だけをまとめて確認できます。保護者の方は「お子さん」、選手ご本人は「自分」を選んでください。</div>
          </FormRow>
        </FormSec>

        <div style={{ background:"#e3f2fd",border:"1px solid #90caf9",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#1565c0",marginBottom:12 }}>
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

        {!forced && (
          <div style={{ marginTop:32, borderTop:`1px solid ${C.border}`, paddingTop:20 }}>
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
            <div style={{ fontSize:11, color:C.textSec, marginTop:8, textAlign:"center" }}>
              ※試合データは削除されません
            </div>
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
  const [newName, setNewName] = useState("");
  const [newPosition, setNewPosition] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newDominantHand, setNewDominantHand] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editPosition, setEditPosition] = useState("");
  const [editTeamName, setEditTeamName] = useState("");
  const [editDominantHand, setEditDominantHand] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

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

  const handLabel = (k) => k==="right" ? "右利き" : k==="left" ? "左利き" : "";

  async function handleAdd() {
    setErrorMsg("");
    if (!newName.trim()) return;
    try {
      await savePlayer({ player_name: newName.trim(), position: newPosition || null, dominant_hand: newDominantHand || null, is_own_team: tab==="own", team_name: tab==="own" ? mySchoolName : newTeamName });
      setNewName(""); setNewPosition(""); setNewTeamName(""); setNewDominantHand("");
      reload();
    } catch (e) { setErrorMsg("追加に失敗しました: " + (e.message || JSON.stringify(e))); }
  }
  async function handleUpdate(id) {
    setErrorMsg("");
    if (!editName.trim()) return;
    try {
      await savePlayer({ id, player_name: editName.trim(), position: editPosition || null, dominant_hand: editDominantHand || null, is_own_team: tab==="own", team_name: tab==="own" ? mySchoolName : editTeamName });
      setEditingId(null); reload();
    } catch (e) { setErrorMsg("更新に失敗しました: " + (e.message || JSON.stringify(e))); }
  }
  async function handleDelete(id) {
    if (!window.confirm("この選手をマスターから削除しますか？")) return;
    setErrorMsg("");
    try { await deletePlayerFromRoster(id); reload(); }
    catch (e) { setErrorMsg("削除に失敗しました"); }
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
            onClick={()=>{ setTab(v); setEditingId(null); setFilterSchool(""); }}>{l}</button>
        ))}
      </div>
      <div style={{ padding:14 }}>
        <div style={{ background:"#e3f2fd", border:"1px solid #90caf9", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#1565c0", marginBottom:14 }}>
          {tab==="own" ? "ℹ️ ここで登録した選手は、同じ学校のメンバー全員が試合作成時に「自チーム」として選べます。" : "ℹ️ 対戦相手の選手を登録しておくと、試合作成時に「相手チーム」として選べ、対戦相手別の分析もしやすくなります。"}
        </div>
        <FormSec title={tab==="own" ? "自チームの選手を追加" : "他チームの選手を追加"}>
          <FormRow label="選手名">
            <input style={S.inp} placeholder="例：田中 蓮" value={newName} onChange={e=>setNewName(e.target.value)} />
          </FormRow>
          {tab==="own" ? (
            <FormRow label="学校名・チーム名">
              <div style={{ ...S.inp, background:C.gray, color:C.textSec, display:"flex", alignItems:"center" }}>{mySchoolName || "（プロフィールから自動入力）"}</div>
            </FormRow>
          ) : (
            <FormRow label="学校名・チーム名">
              <select style={{ ...S.inp, appearance:"none" }} value={newTeamName} onChange={e=>setNewTeamName(e.target.value)}>
                <option value="">選択してください</option>
                {schools.map(s=>(<option key={s.id} value={s.name}>{s.name}</option>))}
              </select>
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

        {tab==="other" && otherSchoolNames.length > 0 && (
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>学校で絞り込み</div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              <button style={{ ...S.togBtn(filterSchool==="", C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>setFilterSchool("")}>すべて</button>
              {otherSchoolNames.map(name=>(
                <button key={name} style={{ ...S.togBtn(filterSchool===name, C.navy), fontSize:11, padding:"6px 10px" }} onClick={()=>setFilterSchool(name)}>{name}</button>
              ))}
            </div>
          </div>
        )}

        {loading && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>読み込み中...</div>}
        {!loading && tab==="own" && ownPlayers.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>登録されている選手がいません</div>}
        {!loading && tab==="other" && visibleOtherPlayers.length===0 && <div style={{ textAlign:"center", color:C.textSec, padding:"20px 0" }}>登録されている選手がいません</div>}

        {tab==="own" && ownPlayers.map(p => (
          <div key={p.id} style={S.card}>
            {editingId===p.id ? (
              <div style={{ padding:12 }}>
                <input style={{ ...S.inp, marginBottom:8 }} placeholder="選手名" value={editName} onChange={e=>setEditName(e.target.value)} />
                <div style={{ ...S.inp, background:C.gray, color:C.textSec, marginBottom:8, display:"flex", alignItems:"center" }}>{mySchoolName || "（プロフィールから自動入力）"}</div>
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
                <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer" }} onClick={()=>{ setEditingId(p.id); setEditName(p.player_name); setEditPosition(p.position||""); setEditTeamName(p.team_name||""); setEditDominantHand(p.dominant_hand||""); }}>✏️</button>
                <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer", color:C.red }} onClick={()=>handleDelete(p.id)}>🗑</button>
              </div>
            )}
          </div>
        ))}

        {tab==="other" && visibleOtherPlayers.map(p => (
          <div key={p.id} style={S.card}>
            {editingId===p.id ? (
              <div style={{ padding:12 }}>
                <input style={{ ...S.inp, marginBottom:8 }} placeholder="選手名" value={editName} onChange={e=>setEditName(e.target.value)} />
                <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>学校名・チーム名</div>
                <select style={{ ...S.inp, appearance:"none", marginBottom:8 }} value={editTeamName} onChange={e=>setEditTeamName(e.target.value)}>
                  <option value="">選択してください</option>
                  {schools.map(s=>(<option key={s.id} value={s.name}>{s.name}</option>))}
                </select>
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
                <button style={{ background:"none", border:"none", fontSize:16, cursor:"pointer" }} onClick={()=>{ setEditingId(p.id); setEditName(p.player_name); setEditPosition(p.position||""); setEditTeamName(p.team_name||""); setEditDominantHand(p.dominant_hand||""); }}>✏️</button>
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

// ============================================================
// 団体戦画面
// ============================================================
function TeamMatchScreen({ onBack, onOpen, onNavigate }) {
  const [teamMatches, setTeamMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("list"); // list | setup | detail
  const [editTarget, setEditTarget] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  const [toast, setToast] = useState(null);
  useEffect(() => { if (toast) { const t = setTimeout(()=>setToast(null), 3000); return ()=>clearTimeout(t); } }, [toast]);

  const reload = async () => {
    setLoading(true);
    const data = await getTeamMatches();
    setTeamMatches(data);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  if (screen === "setup") {
    return (
      <TeamMatchSetup
        editing={editTarget}
        onSave={async (tm) => {
          await saveTeamMatch(tm);
          setEditTarget(null);
          setScreen("list");
          setToast("団体戦を保存しました！");
          reload();
        }}
        onCancel={() => { setEditTarget(null); setScreen("list"); }}
        onOpen={onOpen}
      />
    );
  }

  if (screen === "detail" && detailTarget) {
    return (
      <TeamMatchDetail
        tm={detailTarget}
        onBack={() => { setDetailTarget(null); setScreen("list"); reload(); }}
        onEdit={() => { setEditTarget(detailTarget); setScreen("setup"); }}
        onOpen={onOpen}
        onDelete={async () => {
          if (!window.confirm("この団体戦を削除しますか？（個人戦データは残ります）")) return;
          await deleteTeamMatch(detailTarget.id);
          setDetailTarget(null);
          setScreen("list");
          reload();
        }}
        onSave={async (updated) => {
          await saveTeamMatch(updated);
          const refreshed = await getTeamMatches();
          const found = refreshed.find(t => t.id === updated.id);
          if (found) setDetailTarget(found);
          setTeamMatches(refreshed);
          setToast("保存しました！");
        }}
      />
    );
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>団体戦</span>
        </div>
      </div>
      {toast && (
        <div style={{ position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:"#1b5e20",color:"#fff",padding:"10px 20px",borderRadius:20,fontSize:13,fontWeight:700,zIndex:9999,whiteSpace:"nowrap" }}>
          {toast}
        </div>
      )}
      <div style={{ padding:14, paddingBottom:90 }}>
        {loading && <div style={{ textAlign:"center",color:C.textSec,marginTop:40 }}>読み込み中...</div>}
        {!loading && teamMatches.length === 0 && (
          <div style={{ textAlign:"center",color:C.textSec,marginTop:60 }}>
            <div style={{ fontSize:40,marginBottom:12 }}>🏆</div>
            団体戦の記録がありません
          </div>
        )}
        {!loading && teamMatches.map(tm => {
          const { wins, loses, isWin } = calcTeamResult(tm);
          const finished = tm.matches.filter(m => m.status === "finished").length;
          return (
            <div key={tm.id} style={{ ...S.card, marginBottom:10, cursor:"pointer" }}
              onClick={() => { setDetailTarget(tm); setScreen("detail"); }}>
              <div style={{ height:4, background: finished===0 ? C.border : isWin ? C.teamA : C.teamB }} />
              <div style={{ padding:"12px 14px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ fontSize:13,fontWeight:700 }}>{tm.tournament_name || "団体戦"}</span>
                  <span style={{ fontSize:11,color:C.textSec }}>{fmtDate(tm.match_date)}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:15,fontWeight:700 }}>vs {tm.opponent_name}</span>
                  <span style={{ fontSize:20,fontWeight:900,color: finished===0 ? C.textSec : isWin ? C.teamA : C.red }}>
                    {finished === 0 ? "—" : `${wins}勝${loses}敗`}
                  </span>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  {[0,1,2].map(i => {
                    const m = tm.matches[i];
                    const win = m?.status==="finished" ? m.match_score_a > m.match_score_b : null;
                    return (
                      <span key={i} style={{ fontSize:11,padding:"2px 10px",borderRadius:20,fontWeight:700,
                        background: win===null ? C.border+"44" : win ? C.teamA+"22" : C.red+"22",
                        color: win===null ? C.textSec : win ? C.teamA : C.red }}>
                        {i+1}番{win===null ? "—" : win ? "○" : "●"}
                      </span>
                    );
                  })}
                  <span style={{ fontSize:10,padding:"2px 8px",borderRadius:20,background:C.navyMid+"22",color:C.navyMid,fontWeight:600 }}>
                    {tm.finish_early ? "2勝終了" : "全試合"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <button
        style={{ position:"fixed",bottom:20,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.accent},#00a066)`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,194,122,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }}
        onClick={() => { setEditTarget(null); setScreen("setup"); }}
      >＋</button>
    </div>
  );
}

function TeamMatchSetup({ editing, onSave, onCancel, onOpen }) {
  const today = () => new Date().toISOString().slice(0,10);
  const [matchDate, setMatchDate] = useState(editing?.match_date ?? today());
  const [tournamentName, setTournamentName] = useState(editing?.tournament_name ?? "");
  const [venue, setVenue] = useState(editing?.venue ?? "");
  const [opponentName, setOpponentName] = useState(editing?.opponent_name ?? "");
  const [finishEarly, setFinishEarly] = useState(editing?.finish_early !== false);
  const [saving, setSaving] = useState(false);

  const canSave = opponentName.trim();

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({
        id: editing?.id || uid(),
        match_date: matchDate,
        tournament_name: tournamentName.trim() || null,
        venue: venue.trim() || null,
        opponent_name: opponentName.trim(),
        format: "best_of_3",
        finish_early: finishEarly,
        match_id_1: editing?.match_id_1 || null,
        match_id_2: editing?.match_id_2 || null,
        match_id_3: editing?.match_id_3 || null,
      });
    } catch(e) {
      alert("保存に失敗しました: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onCancel}>←</button>
          <span style={{ fontSize:18,fontWeight:800,color:C.white }}>{editing ? "団体戦を編集" : "団体戦を新規作成"}</span>
        </div>
      </div>
      <div style={{ padding:14 }}>
        <FormSec title="基本情報">
          <FormRow label="試合日">
            <input type="date" style={S.inp} value={matchDate} onChange={e=>setMatchDate(e.target.value)} />
          </FormRow>
          <FormRow label="大会名">
            <input style={S.inp} placeholder="例：○○高校選手権" value={tournamentName} onChange={e=>setTournamentName(e.target.value)} />
          </FormRow>
          <FormRow label="会場">
            <input style={S.inp} placeholder="例：○○市民コート" value={venue} onChange={e=>setVenue(e.target.value)} />
          </FormRow>
          <FormRow label="相手校名（必須）">
            <input style={S.inp} placeholder="例：久留米筑水" value={opponentName} onChange={e=>setOpponentName(e.target.value)} />
          </FormRow>
        </FormSec>
        <FormSec title="形式">
          <FormRow label="試合終了タイミング">
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ ...S.togBtn(finishEarly, C.navy), flex:1 }} onClick={()=>setFinishEarly(true)}>
                <div style={{ fontSize:13,fontWeight:700 }}>2勝で終了</div>
              </button>
              <button style={{ ...S.togBtn(!finishEarly, C.navy), flex:1 }} onClick={()=>setFinishEarly(false)}>
                <div style={{ fontSize:13,fontWeight:700 }}>3試合全部</div>
              </button>
            </div>
          </FormRow>
        </FormSec>
        <button
          style={{ ...S.btn((canSave&&!saving) ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border), color:(canSave&&!saving)?C.white:C.textSec }}
          disabled={!canSave || saving}
          onClick={handleSave}
        >
          {saving ? "保存中..." : "作成する"}
        </button>
      </div>
    </div>
  );
}

function TeamMatchDetail({ tm, onBack, onEdit, onOpen, onDelete, onSave, onReload }) {
  const { wins, loses, results, isWin } = calcTeamResult(tm);
  const finished = tm.matches.filter(m => m.status === "finished").length;
  const [saving, setSaving] = useState(false);
  const [editingSlot, setEditingSlot] = useState(null); // 選手編集中の番手(1/2/3)
  const [slotAP1, setSlotAP1] = useState("");
  const [slotAP2, setSlotAP2] = useState("");
  const [slotBP1, setSlotBP1] = useState("");
  const [slotBP2, setSlotBP2] = useState("");
  const [roster, setRoster] = useState([]);
  useEffect(() => { getPlayerRoster().then(setRoster); }, []);
  const ownRoster = roster.filter(p => p.is_own_team !== false);
  const oppRoster = roster.filter(p => p.is_own_team === false);

  function openSlotEdit(slot) {
    const m = tm.matches[slot-1];
    setSlotAP1(m?.players.find(p=>p.team==="A"&&p.order_num===1)?.player_name || "");
    setSlotAP2(m?.players.find(p=>p.team==="A"&&p.order_num===2)?.player_name || "");
    setSlotBP1(m?.players.find(p=>p.team==="B"&&p.order_num===1)?.player_name || "");
    setSlotBP2(m?.players.find(p=>p.team==="B"&&p.order_num===2)?.player_name || "");
    setEditingSlot(slot);
  }

  async function saveSlotPlayers() {
    setSaving(true);
    try {
      const slot = editingSlot;
      const m = tm.matches[slot-1];
      const aClubName = m?.players.find(p=>p.team==="A")?.club_name || "";
      const bClubName = m?.players.find(p=>p.team==="B")?.club_name || tm.opponent_name || "";
      let mid = m?.id;
      if (!mid) {
        // まだ試合がない場合は新規作成
        mid = uid();
        const { data:{ user } } = await supabase.auth.getUser();
        const newMatch = {
          id:mid, created_by:user.id,
          match_date:tm.match_date, venue:tm.venue||null,
          tournament_name:tm.tournament_name||null, round:`団体戦${slot}番手`,
          match_type:"tournament", game_format:7, is_doubles:true,
          first_server:null, status:"scheduled",
          match_score_a:0, match_score_b:0, memo:"", court_number:null,
          is_younger:true, games:[],
          players:[],
        };
        await saveMatch(newMatch);
        const { matches:_, ...saveData } = { ...tm, [`match_id_${slot}`]:mid };
        await onSave(saveData);
      }
      // 選手情報を更新
      const players = [
        { id:uid(), match_id:mid, team:"A", player_name:slotAP1.trim(), club_name:aClubName, position:null, order_num:1 },
        ...(slotAP2.trim() ? [{ id:uid(), match_id:mid, team:"A", player_name:slotAP2.trim(), club_name:aClubName, position:null, order_num:2 }] : []),
        { id:uid(), match_id:mid, team:"B", player_name:slotBP1.trim(), club_name:bClubName, position:null, order_num:1 },
        ...(slotBP2.trim() ? [{ id:uid(), match_id:mid, team:"B", player_name:slotBP2.trim(), club_name:bClubName, position:null, order_num:2 }] : []),
      ];
      await supabase.from("match_players").delete().eq("match_id", mid);
      if (players.length > 0) await supabase.from("match_players").insert(players);
      setEditingSlot(null);
      // 再読み込みのためにonSaveを空で呼ぶ
      const { matches:__, ...sd } = tm;
      await onSave(sd);
    } catch(e) {
      alert("保存に失敗しました: " + (e.message||e));
    } finally {
      setSaving(false);
    }
  }

  // 試合を紐づける
  async function linkMatch(slot, matchId) {
    setSaving(true);
    try {
      const updated = {
        ...tm,
        [`match_id_${slot}`]: matchId,
      };
      // matchesを除いたデータで保存
      const { matches: _, ...saveData } = updated;
      await onSave(saveData);
    } catch(e) {
      alert("保存に失敗しました: " + (e.message||e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
          <div>
            <div style={{ fontSize:16,fontWeight:800,color:C.white }}>{tm.tournament_name || "団体戦"}</div>
            <div style={{ fontSize:11,color:"rgba(255,255,255,0.7)" }}>{fmtDate(tm.match_date)}{tm.venue ? " · "+tm.venue : ""}</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:18,cursor:"pointer" }} onClick={onReload}>🔄</button>
          <button style={{ background:"none",border:"none",color:C.white,fontSize:18,cursor:"pointer" }} onClick={onEdit}>✏️</button>
        </div>
      </div>
      <div style={{ padding:14, paddingBottom:90 }}>
        {/* 結果サマリー */}
        <div style={{ ...S.card, padding:"16px 14px", marginBottom:14, textAlign:"center" }}>
          <div style={{ fontSize:13,color:C.textSec,marginBottom:4 }}>vs {tm.opponent_name}</div>
          <div style={{ fontSize:36,fontWeight:900,color: finished===0 ? C.textSec : isWin ? C.teamA : C.red, marginBottom:8 }}>
            {finished === 0 ? "未実施" : `${wins}勝${loses}敗`}
          </div>
          <div style={{ fontSize:13,fontWeight:700,color: finished===0 ? C.textSec : isWin ? C.teamA : C.red }}>
            {finished === 0 ? "" : isWin ? "勝利 🏆" : "敗退"}
          </div>
          <div style={{ display:"flex",gap:6,justifyContent:"center",marginTop:10 }}>
            {[0,1,2].map(i => {
              const win = results[i];
              return (
                <span key={i} style={{ fontSize:13,padding:"4px 14px",borderRadius:20,fontWeight:700,
                  background: win===null ? C.border+"44" : win==="win" ? C.teamA+"22" : C.red+"22",
                  color: win===null ? C.textSec : win==="win" ? C.teamA : C.red }}>
                  {i+1}番{win===null ? "—" : win==="win" ? "○" : "●"}
                </span>
              );
            })}
          </div>
        </div>

        {/* 各試合 */}
        <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:8 }}>各試合の記録</div>
        {[1,2,3].map(slot => {
          const m = tm.matches[slot-1];
          const isNeeded = tm.finish_early
            ? slot === 1 || slot === 2 || (results[0] !== null && results[1] !== null && results[0] === results[1] ? false : true)
            : true;
          // 2勝終了の場合、すでに2勝2敗が決まっていれば3試合目不要
          const alreadyDecided = tm.finish_early && slot === 3 && (wins >= 2 || loses >= 2) && finished >= 2;

          return (
            <div key={slot} style={{ ...S.card, marginBottom:10 }}>
              <div style={{ padding:"12px 14px" }}>
                <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:8 }}>{slot}番手</div>
                {alreadyDecided && !m && (
                  <div style={{ fontSize:13,color:C.textSec,textAlign:"center",padding:"8px 0" }}>
                    ✅ 試合終了（2勝確定）
                  </div>
                )}
                {!alreadyDecided && !m && (
                  <div>
                    <div style={{ fontSize:12,color:C.textSec,marginBottom:8 }}>
                      この番手の試合をまだ記録していません
                    </div>
                    <button
                      style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13 }}
                      onClick={async () => {
                        // 新規試合を作成して紐づけ
                        const mid = uid();
                        const { data:{ user } } = await supabase.auth.getUser();
                        const profile = await getMyProfile();
                        const allSchools = await getSchools();
                        const mine = allSchools.find(s => s.id === profile?.school_id);
                        const match = {
                          id: mid, created_by: user.id,
                          match_date: tm.match_date,
                          venue: tm.venue || null,
                          tournament_name: tm.tournament_name || null,
                          round: `団体戦${slot}番手`,
                          match_type: "tournament",
                          game_format: 7,
                          is_doubles: true,
                          first_server: null,
                          status: "scheduled",
                          match_score_a: 0, match_score_b: 0,
                          memo: "", court_number: null,
                          is_younger: true,
                          players: [], games: [],
                        };
                        await saveMatch(match);
                        await linkMatch(slot, mid);
                        onOpen(mid);
                      }}
                    >
                      🎾 {slot}番手の試合を記録する
                    </button>
                  </div>
                )}
                {m && (
                  <div>
                    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
                      <div>
                        <div style={{ fontSize:11,color:C.textSec }}>{m.players.find(p=>p.team==="A")?.club_name || ""}</div>
                        <div style={{ fontSize:13,fontWeight:700 }}>{m.players.filter(p=>p.team==="A").map(p=>p.player_name).join("/") || "—"}</div>
                      </div>
                      <div style={{ fontSize:20,fontWeight:900,color: m.status==="finished" ? (m.match_score_a>m.match_score_b?C.teamA:C.red) : C.textSec }}>
                        {m.status==="finished" ? `${m.match_score_a}-${m.match_score_b}` : m.status==="active" ? "進行中" : "予定"}
                      </div>
                      <div>
                        <div style={{ fontSize:11,color:C.textSec,textAlign:"right" }}>{m.players.find(p=>p.team==="B")?.club_name || ""}</div>
                        <div style={{ fontSize:13,fontWeight:700,textAlign:"right" }}>{m.players.filter(p=>p.team==="B").map(p=>p.player_name).join("/") || "—"}</div>
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:8, marginTop:8 }}>
                      <button
                        style={{ flex:1, padding:"8px 0", background:"#e8f5e9", color:C.accent, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }}
                        onClick={()=>openSlotEdit(slot)}
                      >👥 選手情報を入力</button>
                      <button
                        style={{ flex:1, padding:"8px 0", background:`linear-gradient(135deg,${C.accent},#00a066)`, color:C.white, border:"none", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer" }}
                        onClick={()=>onOpen(m.id)}
                      >🎾 スコア記録</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button
          style={{ ...S.btn("transparent"), color:C.red, border:`1px solid ${C.red}`, fontSize:13, marginTop:16 }}
          onClick={onDelete}
        >
          🗑 この団体戦を削除する
        </button>
      </div>

      {/* 選手情報編集モーダル */}
      {editingSlot && (
        <Modal onClose={()=>setEditingSlot(null)}>
          <div style={{ fontSize:15,fontWeight:800,marginBottom:16 }}>{editingSlot}番手の選手情報</div>
          <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:6 }}>自チーム</div>
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:3 }}>選手1</div>
            <input style={S.inp} placeholder="選手名" value={slotAP1} onChange={e=>setSlotAP1(e.target.value)}/>
            {ownRoster.length>0 && <div style={{ marginTop:4 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(slotAP1===p.player_name)} onClick={()=>setSlotAP1(p.player_name)}>{p.player_name}</span>))}</div>}
          </div>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:3 }}>選手2（ペア）</div>
            <input style={S.inp} placeholder="選手名" value={slotAP2} onChange={e=>setSlotAP2(e.target.value)}/>
            {ownRoster.length>0 && <div style={{ marginTop:4 }}>{ownRoster.map(p=>(<span key={p.id} style={S.chip(slotAP2===p.player_name)} onClick={()=>setSlotAP2(p.player_name)}>{p.player_name}</span>))}</div>}
          </div>
          <div style={{ fontSize:12,fontWeight:700,color:C.textSec,marginBottom:6 }}>相手チーム（{tm.opponent_name}）</div>
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:3 }}>選手1</div>
            <input style={S.inp} placeholder="選手名" value={slotBP1} onChange={e=>setSlotBP1(e.target.value)}/>
            {oppRoster.filter(p=>p.team_name===tm.opponent_name).length>0 && <div style={{ marginTop:4 }}>{oppRoster.filter(p=>p.team_name===tm.opponent_name).map(p=>(<span key={p.id} style={S.chip(slotBP1===p.player_name)} onClick={()=>setSlotBP1(p.player_name)}>{p.player_name}</span>))}</div>}
          </div>
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:11,color:C.textSec,marginBottom:3 }}>選手2（ペア）</div>
            <input style={S.inp} placeholder="選手名" value={slotBP2} onChange={e=>setSlotBP2(e.target.value)}/>
            {oppRoster.filter(p=>p.team_name===tm.opponent_name).length>0 && <div style={{ marginTop:4 }}>{oppRoster.filter(p=>p.team_name===tm.opponent_name).map(p=>(<span key={p.id} style={S.chip(slotBP2===p.player_name)} onClick={()=>setSlotBP2(p.player_name)}>{p.player_name}</span>))}</div>}
          </div>
          <button
            style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), marginBottom:8 }}
            disabled={saving || !slotAP1.trim() || !slotAP2.trim() || !slotBP1.trim() || !slotBP2.trim()}
            onClick={saveSlotPlayers}
          >{saving ? "保存中..." : "保存する"}</button>
          <button style={{ ...S.btn("#f0f0f0"), color:C.text }} onClick={()=>setEditingSlot(null)}>キャンセル</button>
        </Modal>
      )}
    </div>
  );
}


// 団体戦詳細のラッパー（IDからデータを取得して表示）
function TeamMatchDetailWrapper({ tmId, onBack, onOpen }) {
  const [tm, setTm] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    const list = await getTeamMatches();
    const found = list.find(t => t.id === tmId);
    setTm(found || null);
    setLoading(false);
  };
  useEffect(() => { reload(); }, [tmId]);

  if (loading) return (
    <div style={S.page}>
      <div style={S.hdr}><span style={{ fontSize:18,fontWeight:800,color:C.white }}>読み込み中...</span></div>
    </div>
  );
  if (!tm) return (
    <div style={S.page}>
      <div style={S.hdr}>
        <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer" }} onClick={onBack}>←</button>
      </div>
      <div style={{ padding:24,textAlign:"center",color:C.textSec }}>団体戦データが見つかりません</div>
    </div>
  );
  return (
    <TeamMatchDetail
      tm={tm}
      onBack={onBack}
      onEdit={()=>{}}
      onOpen={id=>{ onOpen(id); }}
      onReload={reload}
      onDelete={async ()=>{
        if (!window.confirm("この団体戦を削除しますか？（個人戦データは残ります）")) return;
        await deleteTeamMatch(tmId);
        onBack();
      }}
      onSave={async (updated)=>{
        const { matches: _, ...saveData } = updated;
        await saveTeamMatch(saveData);
        await reload();
      }}
    />
  );
}

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

  const reload = useCallback(() => {
    setLoading(true);
    getSchools().then(list => { setSchools(list); setLoading(false); });
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
      setErrorMsg(e.message?.includes("duplicate") ? "同じ名前・同じ区分の学校がすでに登録されています" : (e.message || "追加に失敗しました"));
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
        <div style={{ background:"#e3f2fd",border:"1px solid #90caf9",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#1565c0",marginBottom:14 }}>
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
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                  <button style={{ ...S.btn("#f0f0f0"),color:C.text,fontSize:12 }} onClick={()=>setEditingId(null)}>キャンセル</button>
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
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [name,        setName]        = useState("");
  const [schoolId,    setSchoolId]    = useState(null);
  const [prefecture,  setPrefecture]  = useState("東京都");
  const [genderCategory, setGenderCategory] = useState(null);
  const [category,    setCategory]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [schools, setSchools] = useState([]);
  const [schoolPrefFilter, setSchoolPrefFilter] = useState("");

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
      setErrorMsg(e.message === "Invalid login credentials" ? "メールアドレスまたはパスワードが違います" : (e.message || "ログインに失敗しました"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup() {
    setErrorMsg("");
    if (!email.trim()) { setErrorMsg("メールアドレスを入力してください"); return; }
    if (password.length < 6) { setErrorMsg("パスワードは6文字以上で入力してください"); return; }
    if (!name.trim()) { setErrorMsg("お名前を入力してください"); return; }
    if (!schoolId) { setErrorMsg("学校名を選択してください"); return; }
    if (!genderCategory) { setErrorMsg("男子・女子・共通を選択してください"); return; }
    if (!category) { setErrorMsg("区分を選択してください"); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) throw error;
      if (data.user) {
        const { error: profileErr } = await supabase.from("users").insert({
          id: data.user.id,
          name: name.trim(),
          school_id: schoolId,
          prefecture,
          gender_category: genderCategory,
          category,
        });
        if (profileErr) throw profileErr;
      }
      onAuthed();
    } catch (e) {
      setErrorMsg(e.message || "登録に失敗しました");
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
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>お名前</label>
              <input style={S.inp} placeholder="例：田中 蓮" value={name} onChange={e=>setName(e.target.value)}/>
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>都道府県</label>
              <select style={{ ...S.inp, background:"transparent" }} value={prefecture} onChange={e=>setPrefecture(e.target.value)}>
                {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4 }}>
                <label style={{ fontSize:11,color:C.textSec }}>学校名またはチーム名</label>
                <PrefMiniFilter value={schoolPrefFilter} onChange={setSchoolPrefFilter} options={knownPrefsFrom(schools)} />
              </div>
              <SchoolIdSelect value={schoolId} onChange={setSchoolId} schools={schools} prefFilter={schoolPrefFilter} genderCategory={genderCategory} />
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>男子・女子・共通</label>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {GENDER_OPTIONS.map(g => (
                  <button key={g.key} style={S.togBtn(genderCategory===g.key)} onClick={()=>setGenderCategory(g.key)}>{g.label}</button>
                ))}
              </div>
            </div>
            <div style={{ padding:"14px 16px", borderTop:"1px solid "+C.border }}>
              <label style={S.lbl}>区分</label>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {CATEGORY_OPTIONS.map(c => (
                  <button key={c.key} style={S.togBtn(category===c.key)} onClick={()=>setCategory(c.key)}>{c.label}</button>
                ))}
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
  const [listFilter,   setListFilter]   = useState("all"); // 試合一覧フィルター
  const [toast, setToast] = useState(null); // トースト通知
  const [matchId,      setMatchId]      = useState(null);
  const [copySourceId, setCopySourceId] = useState(null); // コピー元の試合ID
  const [editTargetId, setEditTargetId] = useState(null); // 編集対象の試合ID
  const [tick,         setTick]         = useState(0);
  const [statsPlayerName,   setStatsPlayerName]   = useState(null); // 直接開く選手名（統計画面から遷移時）
  const [statsOpponentName, setStatsOpponentName] = useState(null); // 直接開く対戦相手校名
  const [playerStatsFrom,   setPlayerStatsFrom]   = useState("home"); // 選手戦績画面の戻り先（home/stats）
  const [teamMatchFrom,     setTeamMatchFrom]     = useState("list"); // 団体戦から個人戦を開いたときの戻り先
  const [currentTeamMatchId, setCurrentTeamMatchId] = useState(null); // 現在表示中の団体戦ID
  const [teamMatchReload, setTeamMatchReload] = useState(null); // 団体戦詳細のリロード関数
  const [teamMatchTick, setTeamMatchTick] = useState(0); // 団体戦詳細の再マウント用

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
      setProfile(p);
      setProfileChecked(true);
    });
    return () => { cancelled = true; };
  }, [user]);

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

  // プロフィール確認中は簡易ローディング表示
  if (!profileChecked) {
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
        onBack={()=>setScreen("list")}
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
        onOpen={id=>{ setMatchId(id); setPrevScreen("home"); setScreen("record"); }}
        initialPlayerName={statsPlayerName}
      />
    );
  }
  if (screen==="opponentStats") {
    return (
      <OpponentStatsScreen
        schoolName={statsOpponentName}
        onBack={()=>{ setStatsOpponentName(null); setScreen("stats"); }}
        onOpen={id=>{ setMatchId(id); setScreen("record"); }}
      />
    );
  }

  // ★下部ナビゲーション（ホーム/履歴/分析/マスター）の共通遷移ハンドラ
  function goNav(key) {
    if (key==="home") setScreen("home");
    else if (key==="list") setScreen("list");
    else if (key==="stats") setScreen("stats");
    else if (key==="master") setScreen("master");
    else if (key.startsWith("teamMatchDetail_")) {
      setCurrentTeamMatchId(key.replace("teamMatchDetail_",""));
      setTeamMatchTick(t=>t+1);
      setScreen("teamMatchDetail");
    }
  }

  if (screen==="home") {
    return (
      <HomeScreen
        onNew={()=>{ setCopySourceId(null); setEditTargetId(null); setInitMatchType(null); setPrevScreen("home"); setScreen("setup"); }}
        onOpen={id=>{ setMatchId(id); setScreen("record"); }}
        onNavigate={goNav}
        onGoPlayerStats={()=>{ setStatsPlayerName(null); setPlayerStatsFrom("home"); setScreen("playerStats"); }}
        onProfile={()=>setScreen("profile")}
      />
    );
  }
  if (screen==="master") {
    return (
      <MasterScreen
        onNavigate={goNav}
        onRoster={()=>setScreen("roster")}
        onSchoolAdmin={()=>setScreen("schoolAdmin")}
        onTeamMatch={()=>setScreen("teamMatch")}
      />
    );
  }
  if (screen==="teamMatch") {
    return (
      <TeamMatchScreen
        onBack={()=>setScreen("master")}
        onOpen={id=>{ setMatchId(id); setTeamMatchFrom("teamMatch"); setPrevScreen("teamMatch"); setScreen("record"); }}
        onNavigate={goNav}
      />
    );
  }
  if (screen==="teamMatchDetail" && currentTeamMatchId) {
    return (
      <TeamMatchDetailWrapper
        key={currentTeamMatchId + teamMatchTick}
        tmId={currentTeamMatchId}
        onBack={()=>{ setCurrentTeamMatchId(null); setScreen("teamMatch"); }}
        onOpen={(id)=>{ setMatchId(id); setPrevScreen("teamMatchDetail"); setScreen("record"); }}
      />
    );
  }
  if (screen==="stats") {
    return (
      <StatsScreen
        onNavigate={goNav}
        onOpenPlayer={name=>{ setStatsPlayerName(name); setPlayerStatsFrom("stats"); setScreen("playerStats"); }}
        onOpenOpponent={name=>{ setStatsOpponentName(name); setScreen("opponentStats"); }}
      />
    );
  }

  if (screen==="setup") {
    return (
      <MatchSetup
        sourceMatchId={copySourceId}
        editMatchId={editTargetId}
        initialMatchType={initMatchType}
        onScheduled={()=>{ setInitMatchType(null); setListFilter("scheduled"); setScreen("list"); setTimeout(()=>setListFilter("all"), 100); }}
        onSave={(id, tmId)=>{
          setCopySourceId(null);
          setInitMatchType(null);
          setEditTargetId(null);
          if (tmId) {
            // 団体戦の場合：団体戦詳細画面へ
            setCurrentTeamMatchId(tmId);
            setScreen("teamMatchDetail");
          } else {
            setMatchId(id);
            setPrevScreen("record");
            setScreen("record");
          }
        }}
        onCancel={()=>{
          setCopySourceId(null);
          setInitMatchType(null);
          if (editTargetId) {
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
        onBack={()=>{ setTick(t=>t+1); setMatchId(null); if (prevScreen==="teamMatchDetail") { setTeamMatchTick(t=>t+1); setScreen("teamMatchDetail"); } else { setScreen(prevScreen==="home" ? "home" : "list"); } }}
        onEdit={id=>{ setEditTargetId(id); setScreen("setup"); }}
        onNavigate={key=>{ setTick(t=>t+1); setMatchId(null); goNav(key); }}
      />
    );
  }
  return (
    <MatchList
      key={tick}
      onNew={f=>{ setCopySourceId(null); setEditTargetId(null); setInitMatchType(f && f!=="all" && f!=="scheduled" ? f : null); setPrevScreen("list"); setScreen("setup"); }}
      onOpen={id=>{setMatchId(id); setPrevScreen("list"); setScreen("record");}}
      onCopy={id=>{ setCopySourceId(id); setEditTargetId(null); setInitMatchType(null); setPrevScreen("list"); setScreen("setup"); }}
      onStartScheduled={async (id, firstServer)=>{ try { await startScheduledMatch(id, firstServer); setMatchId(id); setPrevScreen("list"); setScreen("record"); setTick(t=>t+1); } catch(e) { alert("試合開始エラー: " + JSON.stringify({msg: e?.message, code: e?.code, details: e?.details, hint: e?.hint})); } }}
      onProfile={()=>setScreen("profile")}
      onRoster={()=>setScreen("roster")}
      onSchoolAdmin={()=>setScreen("schoolAdmin")}
      onNavigate={goNav}
      initialFilter={listFilter}
      initialToast={listFilter==="scheduled" ? "📅 試合予定を登録しました！" : null}
    />
  );
}
