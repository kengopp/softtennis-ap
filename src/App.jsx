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

// 結果（新規記録時の選択肢：ウィナー / エラーの2択）
const RESULT_TYPES = [
  { key: "winner", label: "決めた",   is_winner: true  },
  { key: "error",  label: "ミスした", is_winner: false },
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
    is_younger: match.is_younger !== false,
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

  // ゲーム・ポイント・フォルトも同様に、入れ直す（子テーブルから順に削除）
  await supabase.from("points").delete().eq("match_id", match.id);
  await supabase.from("faults").delete().eq("match_id", match.id);
  await supabase.from("games").delete().eq("match_id", match.id);
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
        is_winner: pt.is_winner, score_a_after: pt.score_a_after, score_b_after: pt.score_b_after,
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
}

async function deleteMatch(id) {
  const { error } = await supabase.from("matches").delete().eq("id", id);
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
  return data;
}

async function saveMyProfile(profile) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("ログインしていません");
  const updates = {
    name: profile.name,
    school_id: profile.school_id,
    prefecture: profile.prefecture,
    category: profile.category,
    gender_category: profile.gender_category,
    linked_player_id: profile.linked_player_id ?? null,
  };
  if (profile.is_approved !== undefined) updates.is_approved = profile.is_approved;
  const { error } = await supabase.from("users").update(updates).eq("id", user.id);
  if (error) throw error;
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
  const { data, error } = await supabase.from("users").select("id, name, is_approved").eq("is_approved", true).order("name");
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
// 団体戦データ層
// ============================================================
async function getTeamMatches() {
  const { data, error } = await supabase
    .from("team_matches")
    .select("*")
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
  const { data: m, error } = await supabase.from("team_matches").select("*").eq("id", id).single();
  if (error || !m) { console.error(error); return null; }
  const { data: games } = await supabase.from("team_match_games").select("*").eq("team_match_id", id).order("order_num");
  return { ...m, games: games ?? [] };
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

async function deleteTeamMatch(id) {
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
  const { data: games } = await supabase.from("team_match_games").select("*").eq("team_match_id", teamMatchId);
  if (!games) return;
  const matchIds = games.filter(g => g.match_id).map(g => g.match_id);
  if (matchIds.length === 0) return;
  const { data: matches } = await supabase.from("matches").select("id,match_score_a,match_score_b,status").in("id", matchIds);
  if (!matches) return;

  const matchMap = {};
  matches.forEach(m => { matchMap[m.id] = m; });

  // team_match_gamesのstatusをmatch.statusと同期させる
  for (const g of games) {
    if (!g.match_id) continue;
    const m = matchMap[g.match_id];
    if (!m) continue;
    if (m.status === "finished" && g.status !== "finished") {
      await supabase.from("team_match_games").update({ status:"finished", recorder_id:null, recorder_name:null }).eq("id", g.id);
      g.status = "finished"; // ローカルも更新
    }
  }

  let myScore = 0, oppScore = 0;
  for (const g of games) {
    if (!g.match_id) continue;
    const m = matchMap[g.match_id];
    // match.statusがfinishedなら集計（team_match_games.statusに依存しない）
    if (!m || m.status !== "finished") continue;
    if (m.match_score_a > m.match_score_b) myScore++;
    else if (m.match_score_b > m.match_score_a) oppScore++;
  }

  const { data: tm } = await supabase.from("team_matches").select("format").eq("id", teamMatchId).single();
  const winTarget = tm?.format === "best2" ? 2 : 3;
  const totalGames = tm?.format === "best2" ? 3 : 3;

  // 勝敗決定：どちらかが必要勝利数に達した場合のみfinished
  const winDecided = myScore >= winTarget || oppScore >= winTarget;

  // 全試合終了：match_idが設定されている全番手が終了済み
  const registeredGames = games.filter(g => g.match_id);
  const allRegisteredDone = registeredGames.length > 0 && registeredGames.every(g => {
    const m = matchMap[g.match_id];
    return m?.status === "finished" || g.status === "suspended";
  });
  // 全番手登録済みかつ全試合終了の場合のみfinished（未登録番手があれば進行中）
  const allSlotsFilled = games.length >= totalGames;
  const allDone = allSlotsFilled && allRegisteredDone;

  const newStatus = winDecided || allDone ? "finished" : "active";

  await supabase.from("team_matches").update({
    my_score: myScore,
    opponent_score: oppScore,
    status: newStatus,
  }).eq("id", teamMatchId);
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
    A: match.players.filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name),
    B: match.players.filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name),
  };
  // ソフトテニスのダブルス規則：1ゲーム内、サーブ側ペアは2ポイントずつ交代でサーブする
  // （選手1が1-2点目、選手2が3-4点目...）。レシーブ側も同じ交代タイミングに対応する選手が受ける。
  // シングルスの場合はteamPlayersが1人なので常にその選手に集計される。
  const individualAt = (players, turn) => players.length<=1 ? (players[0]??null) : (Math.floor(turn/2)%2===0 ? players[0] : players[1]);

  for (const g of match.games) {
    for (const pt of g.points) {
      if (!pt.player_name) continue;
      const playerTeam = teamOf[pt.player_name] ?? pt.scoring_team;
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
    for (const f of (g.faults ?? [])) {
      if (!f.player_name) continue;
      const playerTeam = teamOf[f.player_name] ?? f.server_team;
      const r = ensure(playerTeam, f.player_name);
      r.plays["fault"] = (r.plays["fault"] ?? 0) + 1;
    }

    // ★1stサーブ確率・レシーブミス率（2ポイントごとの選手交代を反映して個人に按分）
    let beforeA = 0, beforeB = 0;       // このポイント開始時点のスコア（フォルト記録との突き合わせ用）
    let serveTurnA = 0, serveTurnB = 0; // 各チームがこのゲームで通算何ポイント目のサーブか
    for (let idx=0; idx<g.points.length; idx++) {
      const pt = g.points[idx];
      const serverTeam  = g.is_final ? finalServer(g.server_team, idx) : g.server_team;
      const receiveTeam = serverTeam==="A" ? "B" : "A";
      const serveTurn   = serverTeam==="A" ? serveTurnA : serveTurnB;

      const serverPlayer   = individualAt(teamPlayers[serverTeam],  serveTurn);
      const receiverPlayer = individualAt(teamPlayers[receiveTeam], serveTurn);

      // このポイントの直前に1stフォルトが記録されていたか（スコア一致で突き合わせ）
      const hadFault = (g.faults ?? []).some(f => f.server_team===serverTeam && f.score_a_at===beforeA && f.score_b_at===beforeB);

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
function MatchList({ onNew, onOpen, onCopy, onProfile, onRoster, onSchoolAdmin, onNavigate, onStartScheduled, initialFilter, initialToast, onOpenTeamMatch, onNewTeamMatch, onCopyTeamMatch, initialMatchMode }) {
  const [timeTab, setTimeTab] = useState(initialMatchMode || "individual"); // individual | team
  const [childOnly, setChildOnly] = useState(false);
  const [allMatches, setAllMatches] = useState([]);
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

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([getMatches(), getTeamMatches(), getSchools()]).then(async ([list, tList, schools]) => {
      // 学校IDから名前へのマップを作成
      const smap = {};
      (schools || []).forEach(s => { smap[s.id] = s.name; });
      setSchoolMap(smap);
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
    if (m.status === "active" || m.status === "scheduled") return true;
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

  // 共通絞り込みロジック
  const filteredMatches = allMatches.filter(m => {
    if (filterStatus === "upcoming" && !isUpcomingMatch(m)) return false;
    if (filterStatus === "finished" && isUpcomingMatch(m)) return false;
    if (!matchesDateFilter(m.match_date)) return false;
    if (childOnly && linkedPlayerName && !m.players.some(p => p.player_name === linkedPlayerName)) return false;
    if (filterSearch.trim()) {
      const q = filterSearch.trim().toLowerCase();
      const players = m.players.map(p => p.player_name).join(" ").toLowerCase();
      const tour = (m.tournament_name || "").toLowerCase();
      const opp = m.players.filter(p=>p.team==="B").map(p=>p.club_name||"").join(" ").toLowerCase();
      if (!players.includes(q) && !tour.includes(q) && !opp.includes(q)) return false;
    }
    return true;
  });

  const filteredTeamMatches = allTeamMatches.filter(tm => {
    if (filterStatus === "upcoming" && !isUpcomingTeamMatch(tm)) return false;
    if (filterStatus === "finished" && isUpcomingTeamMatch(tm)) return false;
    if (!matchesDateFilter(tm.match_date)) return false;
    if (childOnly && linkedPlayerName) {
      // 団体戦はgames内の選手名で絞り込む
      const games = tm.games || [];
      const hasPlayer = games.some(g =>
        [g.a_player1, g.a_player2, g.b_player1, g.b_player2].some(n => n === linkedPlayerName)
      );
      if (!hasPlayer) return false;
    }
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
    await deleteMatch(id);
    setConfirmDelete(null);
    reload();
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

      {/* 上段：個人戦 / 団体戦 タブ */}
      <div style={{ display:"flex", background:"#f0f2f6", padding:3, margin:"10px 14px 0", borderRadius:10 }}>
        {[["individual","🎾 個人戦"],["team","🏆 団体戦"]].map(([v,l])=>(
          <button key={v} style={{ flex:1, padding:9, border:"none", cursor:"pointer", borderRadius:8, fontSize:13, fontWeight:700, background:timeTab===v||(!["individual","team"].includes(timeTab)&&v==="individual")?C.white:"transparent", color:timeTab===v?C.navy:C.textSec, boxShadow:timeTab===v?"0 1px 4px rgba(0,0,0,0.1)":"none" }} onClick={()=>{ setTimeTab(v); }}>{l}</button>
        ))}
      </div>

      {/* 共通絞り込みUI */}
      <div style={{ padding:"10px 14px 0" }}>
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
              const borderColor = m.status==="active" ? C.orange : m.status==="scheduled" ? C.accent : aWin ? C.teamA : bWin ? C.teamB : C.border;
              const isMyMatch = m.created_by === myId;
              return (
                <div key={m.id} style={{ ...S.card, marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" }}>
                  <div style={{ height:4, background:borderColor }}/>
                  <div style={{ padding:"10px 14px", cursor:"pointer" }} onClick={()=>onOpen(m.id)}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                      <span style={{ fontSize:11, color:C.textSec }}>{fmtDate(m.match_date)}{m.tournament_name ? ` · ${m.tournament_name}` : ""}</span>
                      <div style={{ display:"flex", gap:4 }}>
                        {m.status==="active" && <span style={{ fontSize:10, color:C.orange, fontWeight:700, background:"#fff3e0", padding:"1px 8px", borderRadius:10 }}>🔴 進行中</span>}
                        {m.status==="scheduled" && <span style={{ fontSize:10, color:C.accent, fontWeight:700, background:"#e8f5e9", padding:"1px 8px", borderRadius:10 }}>📅 予定</span>}
                        <span style={{ fontSize:10, color:C.textSec, background:"#f0f0f0", padding:"1px 6px", borderRadius:6 }}>{m.game_format}G</span>
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:13, fontWeight:aWin?800:600, color:aWin?C.teamA:C.text }}>{aClub && <span style={{ fontSize:11, color:C.textSec }}>{aClub} </span>}{aNames}</div>
                        <div style={{ fontSize:13, fontWeight:bWin?800:600, color:bWin?C.teamB:C.text, marginTop:2 }}>{bClub && <span style={{ fontSize:11, color:C.textSec }}>{bClub} </span>}{bNames}</div>
                      </div>
                      {m.status!=="scheduled" && <div style={{ fontSize:22, fontWeight:900, color:aWin?C.teamA:bWin?C.teamB:C.textSec, minWidth:48, textAlign:"right" }}>{m.match_score_a}-{m.match_score_b}</div>}
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
          <button style={{ position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.accent},#00a066)`,color:C.white,fontSize:28,border:"none",cursor:"pointer",boxShadow:"0 4px 16px rgba(0,194,122,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }} onClick={()=>onNew()}>＋</button>
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
                      <span style={{ fontSize:10, color:C.textSec }}>{tm.format === "best2" ? "2勝先取" : "3試合全部"}</span>
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
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>削除すると元に戻せません。スコア・スタッツデータもすべて削除されます。</p>
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
            <p style={{ fontSize:12,color:C.textSec,marginBottom:20 }}>削除すると元に戻せません。</p>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
              <button style={{ padding:"11px",background:"#f0f0f0",color:C.text,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={()=>setConfirmDeleteTeam(null)}>キャンセル</button>
              <button style={{ padding:"11px",background:C.red,color:C.white,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={async()=>{ await deleteTeamMatch(confirmDeleteTeam); setConfirmDeleteTeam(null); reload(); }}>削除する</button>
            </div>
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
        setMySchoolName(school ? `${school.name}（${school.category}・${school.prefecture}）` : "");
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
                  <div style={{ width:36,height:36,borderRadius:"50%",background:C.accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:C.accent,flexShrink:0 }}>
                    {m.name?.charAt(0) || "?"}
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
function MasterScreen({ onNavigate, onRoster, onSchoolAdmin, onGroupMembers, onGoalSettings }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { getMyProfile().then(p=>setIsAdmin(!!p?.is_admin)); }, []);

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <span style={{ fontSize:20,fontWeight:800,color:C.white }}>設定</span>
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
          style={{ ...S.card, padding:"16px 14px", cursor:"pointer", display:"flex",justifyContent:"space-between",alignItems:"center" }}
          onClick={onGroupMembers}
        >
          <div>
            <div style={{ fontSize:14,fontWeight:700 }}>👤 グループ参加者</div>
            <div style={{ fontSize:11,color:C.textSec,marginTop:2 }}>参加中のメンバーを確認</div>
          </div>
          <span style={{ fontSize:16,color:C.textSec }}>→</span>
        </div>
      </div>
      <NavBar active="master" onNavigate={onNavigate}/>
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

function HomeScreen({ onNew, onNewTeamMatch, onOpen, onNavigate, onGoPlayerStats, onProfile }) {
  const [allMatches, setAllMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [linkedPlayerName, setLinkedPlayerName] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);

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
                  </div>
                  <button style={{ ...S.btn("#f0f0f0"), color:C.text, fontSize:13 }} onClick={()=>setShowNewModal(false)}>キャンセル</button>
                </div>
              </Modal>
            )}

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
                    <span style={{ fontSize:14,fontWeight:800,color:m.status==="finished"?(aWin?"#2ecc71":"#f97316"):C.textSec }}>
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
// 団体戦 予定登録画面
// ============================================================
function TeamMatchSetup({ editId, copyId, onSave, onCancel }) {
  const [ready, setReady] = useState(!editId && !copyId);
  const [saving, setSaving] = useState(false);
  const [matchDate, setMatchDate] = useState(today());
  const [venue, setVenue] = useState("");
  const [tournamentName, setTournamentName] = useState("");
  const [round, setRound] = useState("");
  const [myTeamDivision, setMyTeamDivision] = useState("");
  const [opponentName, setOpponentName] = useState("");
  const [opponentDivision, setOpponentDivision] = useState("");
  const [format, setFormat] = useState("best2");
  const [courtNumber, setCourtNumber] = useState("");
  const [isYounger, setIsYounger] = useState(true);
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

  const canSave = opponentName.trim();

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
        <FormSec title="試合情報">
          <FormRow label="試合日">
            <input type="date" style={S.inp} value={matchDate} onChange={e=>setMatchDate(e.target.value)}/>
          </FormRow>
          <FormRow label="大会名">
            <VenueField value={tournamentName} onChange={setTournamentName} venues={pastTournaments} placeholder="例：○○高校選手権"/>
          </FormRow>
          <FormRow label="何回戦">
            <VenueField value={round} onChange={setRound} venues={pastRounds} placeholder="例：準々決勝"/>
          </FormRow>
          <FormRow label="会場">
            <VenueField value={venue} onChange={setVenue} venues={venues}/>
          </FormRow>
          <FormRow label="コート番号（任意）">
            <VenueField value={courtNumber} onChange={setCourtNumber} venues={pastCourtNumbers} placeholder="例：3番コート"/>
          </FormRow>
          <FormRow label="若番 / 遅番（必須）">
            <div style={{ fontSize:11, color:C.textSec, marginBottom:6 }}>自チームはトーナメント表のどちら側ですか？</div>
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ ...S.togBtn(isYounger===true, C.navy), flex:1, padding:"10px 4px" }} onClick={()=>setIsYounger(true)}>
                <div style={{ fontSize:13, fontWeight:700 }}>若番</div>
              </button>
              <button style={{ ...S.togBtn(isYounger===false, C.navy), flex:1, padding:"10px 4px" }} onClick={()=>setIsYounger(false)}>
                <div style={{ fontSize:13, fontWeight:700 }}>遅番</div>
              </button>
            </div>
          </FormRow>
        </FormSec>

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

        <FormSec title="試合形式">
          <FormRow label="形式">
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ ...S.togBtn(format==="best2", C.navy), flex:1 }} onClick={()=>setFormat("best2")}>2勝先取</button>
              <button style={{ ...S.togBtn(format==="all3", C.navy), flex:1 }} onClick={()=>setFormat("all3")}>3試合全部</button>
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
function TeamMatchDetail({ teamMatchId, onBack, onOpenMatch, onNewMatch, onStartMatch, onEdit }) {
  const [tm, setTm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [liveActive, setLiveActive] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [myUserId, setMyUserId] = useState(null);
  const [myUserName, setMyUserName] = useState("");
  const [schoolMap, setSchoolMap] = useState({}); // school_id -> name
  const [matchDetails, setMatchDetails] = useState({});
  const [serveSelectInfo, setServeSelectInfo] = useState(null); // サーブ選択モーダル用
  const intervalRef = useRef(null);
  const inactiveRef = useRef(null);

  const INACTIVITY_MS = 20 * 60 * 1000; // 20分

  async function loadData() {
    // スコア再集計・データ取得・学校マスターを並列で取得
    const [, data, schools] = await Promise.all([
      recalcTeamMatchScore(teamMatchId),
      getTeamMatch(teamMatchId),
      getSchools(),
    ]);
    if (!data) return;
    // 学校IDマップを作成
    const smap = {};
    (schools || []).forEach(s => { smap[s.id] = s.name; });
    setSchoolMap(smap);
    const matchIds = (data.games || []).filter(g => g.match_id).map(g => g.match_id);
    if (matchIds.length > 0) {
      const { data: matches } = await supabase.from("matches").select("id,match_score_a,match_score_b,status,match_players(team,player_name,club_name,order_num)").in("id", matchIds);
      const map = {};
      (matches || []).forEach(m => { map[m.id] = m; });
      setMatchDetails(map);
    }
    setTm(data);
    setLoading(false);
    setLastUpdated(Date.now());
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setMyUserId(data.user?.id ?? null);
    });
    getMyProfile().then(p => { setMyUserName(p?.name || ""); });
    loadData();
  }, [teamMatchId]);

  // 自動更新
  useEffect(() => {
    if (!liveActive) return;
    intervalRef.current = setInterval(async () => {
      const now = Date.now();
      if (now - lastUpdated > INACTIVITY_MS) {
        setLiveActive(false);
        clearInterval(intervalRef.current);
        return;
      }
      await loadData();
    }, 10000);
    return () => clearInterval(intervalRef.current);
  }, [liveActive, lastUpdated, teamMatchId]);

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
              <span style={{ fontSize:11,color:"#7a5800",fontWeight:700 }}>🔴 LIVE 自動更新中（10秒ごと）</span>
            ) : (
              <span style={{ fontSize:11,color:"#7a5800",fontWeight:700 }}>⏸ 更新停止中（20分間動きなし）</span>
            )}
            <div style={{ display:"flex", gap:6 }}>
              <button style={{ fontSize:11,padding:"4px 8px",background:C.navy,color:C.white,border:"none",borderRadius:6,cursor:"pointer" }} onClick={()=>{ loadData(); }}>今すぐ更新</button>
              {!liveActive && <button style={{ fontSize:11,padding:"4px 8px",background:C.accent,color:C.white,border:"none",borderRadius:6,cursor:"pointer" }} onClick={()=>{ setLiveActive(true); setLastUpdated(Date.now()); }}>再開する</button>}
            </div>
          </div>
        )}

        {/* 番手ごとのカード */}
        {gameStatuses.map(({ orderNum, game, match }) => {
          const recorderName = game?.recorder_name;
          const isRecording = game?.status === "active";
          const isFinished = game?.status === "finished";
          const isSuspended = game?.status === "suspended";
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
                {isSuspended && match?.status !== "finished" && <span style={{ fontSize:11,color:C.textSec,fontWeight:700 }}>⏹ 中断</span>}
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
                    {(isFinished || isSuspended || isRecording) && game?.match_id && (
                      <button style={{ ...S.btn("#f0f0f0"), color:C.navy, fontSize:12, padding:"8px" }} onClick={()=>onOpenMatch && onOpenMatch(game.match_id)}>
                        📋 スコア詳細を見る
                      </button>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize:12,color:C.textSec,marginBottom:8 }}>ペア未登録</div>
                )}
                {canOperateGame(game) && (
                  <>
                    {/* ペア登録済みで未開始 → 試合開始ボタン（選び直しではなく直接開始） */}
                    {isWaiting && (aPlayers || bPlayers) && game?.match_id && (
                      <button
                        style={{ ...S.btn(`linear-gradient(135deg,${C.accent},#00a066)`), fontSize:13, marginTop:8 }}
                        onClick={async ()=>{
                          const { data: matchData } = await supabase.from("matches").select("id,match_players(team,player_name,order_num)").eq("id", game.match_id).single();
                          setServeSelectInfo({ matchData, orderNum, game });
                        }}
                      >
                        🎾 試合開始
                      </button>
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
      <NavBar active="list" onNavigate={()=>{}}/>

      {/* サーブ選択モーダル */}
      {serveSelectInfo && (() => {
        const { matchData, orderNum, game } = serveSelectInfo;
        const aP = (matchData?.match_players||[]).filter(p=>p.team==="A").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "自チーム";
        const bP = (matchData?.match_players||[]).filter(p=>p.team==="B").sort((a,b)=>a.order_num-b.order_num).map(p=>p.player_name).join("/") || "相手チーム";
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:20 }}>
            <div style={{ background:C.white, borderRadius:16, padding:24, width:"100%", maxWidth:360, textAlign:"center" }}>
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
          </div>
        );
      })()}
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
function MatchSetup({ onSave, onCancel, sourceMatchId, editMatchId, initialMatchType, onScheduled, headerLabel, prefillTournament, prefillRound, prefillVenue, prefillDate, prefillOpponent, prefillIsYounger, isTeamMatchGame, teamMatchMyDivision, teamMatchOppDivision, teamMatchMySchoolId, onSavePairOnly }) {
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
  return <MatchSetupForm onSave={onSave} onCancel={onCancel} editing={editing} source={source} initialMatchType={initialMatchType} onScheduled={onScheduled} headerLabel={headerLabel} prefillTournament={prefillTournament} prefillRound={prefillRound} prefillVenue={prefillVenue} prefillDate={prefillDate} prefillOpponent={prefillOpponent} prefillIsYounger={prefillIsYounger} isTeamMatchGame={isTeamMatchGame} teamMatchMyDivision={teamMatchMyDivision} teamMatchOppDivision={teamMatchOppDivision} teamMatchMySchoolId={teamMatchMySchoolId} onSavePairOnly={onSavePairOnly} />;
}

function MatchSetupForm({ onSave, onCancel, editing, source, initialMatchType, onScheduled, headerLabel, prefillTournament, prefillRound, prefillVenue, prefillDate, prefillOpponent, prefillIsYounger, isTeamMatchGame, teamMatchMyDivision, teamMatchOppDivision, teamMatchMySchoolId, onSavePairOnly }) {
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
  const [isYounger,      setIsYounger]      = useState(base ? (base?.is_younger !== false ? true : false) : (prefillIsYounger !== undefined ? prefillIsYounger : true));
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

        {/* 団体戦ペア登録モード：試合情報・形式設定を非表示 */}
        {!isTeamMatchGame && (
          <>
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

        </FormSec>
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
          <FormRow label="チーム名 / 学校名" labelRight={isTeamMatchGame ? null : <PrefMiniFilter value={aClubPref} onChange={setAClubPref} options={knownPrefsFrom(schools)} />}>
            {isTeamMatchGame ? (
              <div style={{ ...S.inp, color:C.text, background:C.gray }}>{aClub || "（自チーム）"}</div>
            ) : (
              <SchoolField value={aClub} onChange={setAClub} schools={schools} placeholder="例：○○中学校" prefFilter={aClubPref} />
            )}
          </FormRow>
          <FormRow label={isDoubles ? "選手1" : "選手名"}>
            <input style={S.inp} placeholder="選手名" value={aP1} onChange={e => setAP1(e.target.value)}/>
            {roster.filter(p => !aClub || p.team_name === aClub || (!isTeamMatchGame && p.is_own_team !== false)).length>0 && (
              <div style={{ marginTop:6 }}>
                {roster.filter(p => !aClub || p.team_name === aClub || (!isTeamMatchGame && p.is_own_team !== false)).map(p=>(
                  <span key={p.id} style={S.chip(aP1===p.player_name)} onClick={()=>setAP1(p.player_name)}>{p.player_name}</span>
                ))}
              </div>
            )}
          </FormRow>
          {isDoubles && (
            <FormRow label="選手2（ペア）">
              <input style={S.inp} placeholder="選手名" value={aP2} onChange={e => setAP2(e.target.value)}/>
              {roster.filter(p => !aClub || p.team_name === aClub || (!isTeamMatchGame && p.is_own_team !== false)).length>0 && (
                <div style={{ marginTop:6 }}>
                  {roster.filter(p => !aClub || p.team_name === aClub || (!isTeamMatchGame && p.is_own_team !== false)).map(p=>(
                    <span key={p.id} style={S.chip(aP2===p.player_name)} onClick={()=>setAP2(p.player_name)}>{p.player_name}</span>
                  ))}
                </div>
              )}
            </FormRow>
          )}
        </FormSec>

        <FormSec title="相手チーム (B)">
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

        {!editing && !isTeamMatchGame && (
          <button
            style={{ ...S.btn(canSchedule ? "linear-gradient(135deg,#7b1fa2,#9c27b0)" : C.border, canSchedule ? C.white : C.textSec), marginTop:4, marginBottom:8 }}
            disabled={!canSchedule || saving}
            onClick={handleSchedule}
          >
            {saving ? "登録中..." : scheduledId ? "📅 試合予定を更新する" : "📅 試合予定として登録する"}
          </button>
        )}
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
        <button
          style={{ ...S.btn((canSave&&!saving) ? `linear-gradient(135deg,${C.accent},#00a066)` : C.border, (canSave&&!saving) ? C.white : C.textSec), marginTop:4 }}
          disabled={!canSave || saving}
          onClick={editing ? ()=>handleSave(null) : handleSaveWithServeSelect}
        >
          {saving ? "保存中..." : (editing ? "保存する 💾" : isTeamMatchGame ? "ペアを登録して試合開始 🎾" : "試合を開始する 🎾")}
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
        if (m && user) {
          if (teamMatchId) {
            // 団体戦：team_match_gamesのrecorder_idと自分のIDを比較
            const { data: tmg } = await supabase
              .from("team_match_games")
              .select("recorder_id, status")
              .eq("match_id", matchId)
              .single();
            if (tmg) {
              // recorder_idが設定されていて自分以外 → 観戦モード
              // recorder_idがnull（誰も記録していない）→ 観戦モード（スコア詳細から入った場合）
              if (!tmg.recorder_id || tmg.recorder_id !== user.id) {
                setViewOnly(true);
              }
            }
          } else {
            // 個人戦：作成者以外は観戦モード
            if (m.created_by !== user.id) setViewOnly(true);
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
  useEffect(() => { if (viewOnly) setTab("score"); }, [viewOnly]);
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
  const [suspendConfirm, setSuspendConfirm] = useState(false); // 中断確認ダイアログ

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
      if(newMA>=winGames||newMB>=winGames){ persist(updM); setModal({type:"matchOver",winner:gWin,gameId:cg.id,sA:newMA,sB:newMB}); }
      else { persist(updM); setModal({type:"gameOver",winner:gWin,num:cg.game_number,gameId:cg.id,sA:newMA,sB:newMB}); }
    } else { persist(updM); }
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
    if(v==="1st") return; // 1stは初期状態の表示のみ（操作不要）
    if(v==="2nd"){ if(fault===0) handleFault(); return; }
    if(v==="df"){
      if(fault===0){
        const cg=currentGame;
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
        <div>
          {PLAY_TYPES.map(p=>{ const isSel=lp.play_type===p.key; return <span key={p.key} style={S.chip(isSel)} onClick={()=>updatePointDetail(gameId,"play_type",p.key)}>{p.label}</span>; })}
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
          <button style={{ background:"none",border:"none",color:C.white,fontSize:20,cursor:"pointer", opacity:navigatingBack?0.5:1 }} disabled={navigatingBack} onClick={handleBack}>{navigatingBack?"…":"←"}</button>
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
            <div key={g.id} style={{ padding:"2px 8px",borderRadius:20,fontSize:10,fontWeight:700,background:g.winner_team===leftTeam?(isYounger?"#2ecc71":"#f97316"):g.winner_team===rightTeam?(isYounger?"#f97316":"#2ecc71"):"rgba(255,255,255,0.2)",color:C.white }}>
              {g.is_final?"🔥":""}G{g.game_number}: {leftScore(g)}-{rightScore(g)}
            </div>
          ))}
        </div>
        {currentGameIsFinal&&currentGame&&<div style={{ textAlign:"center",marginTop:6 }}><span style={{ fontSize:10,fontWeight:800,color:C.white,background:"#dc2626",padding:"2px 10px",borderRadius:20 }}>🔥 ファイナルゲーム（7点先取）</span></div>}
      </div>

      {/* タブ */}
      {viewOnly && (
        <div style={{ background:"#f5f5f5", borderBottom:"1px solid #e0e0e0", padding:"8px 14px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:12, color:C.textSec, fontWeight:700 }}>👁 観戦モード（スコア閲覧のみ）</span>
          <button
            style={{ background:C.navy, border:"none", borderRadius:8, color:"#fff", fontSize:12, padding:"5px 10px", cursor:"pointer", opacity: refreshing ? 0.5 : 1 }}
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
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team===leftTeam?"🏆":""}</span>
                    <span style={{ width:74,textAlign:"center",fontSize:14 }}>{g.winner_team===rightTeam?"🏆":""}</span>
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
              <button style={{ ...S.btn("linear-gradient(135deg,"+C.accent+",#00a066)") }} onClick={handleBack}>← 試合一覧に戻る</button>
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
              {/* サーブ表示：コンパクトなラジオ式(1st/2nd/df) */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",marginBottom:10,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
                <span style={{ fontSize:13,fontWeight:700,color:"#c9740b",display:"flex",alignItems:"center",gap:4 }}>🎾 {serverLabel}</span>
                <div style={{ display:"flex",alignItems:"center",gap:14 }}>
                  <span style={{ fontSize:11,color:C.textSec,fontWeight:700 }}>サービス</span>
                  <div style={{ display:"flex",gap:16 }}>
                    {[{v:"1st",on:fault===0},{v:"2nd",on:fault===1},{v:"df",on:fault===2}].map(opt=>(
                      <div key={opt.v} onClick={()=>handleServeRadio(opt.v)} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer" }}>
                        <div style={{ width:16,height:16,borderRadius:"50%",border:`2px solid ${opt.on?"#3b6fe0":"#ccc"}`,background:opt.on?"#3b6fe0":"#fff",boxShadow:opt.on?"inset 0 0 0 3px #fff":"none" }}/>
                        <span style={{ fontSize:10,fontWeight:700,color:opt.on?"#3b6fe0":"#999" }}>{opt.v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ★得点ボタン（サービスのすぐ下に移動） */}
              <div style={{ fontSize:11,color:C.textSec,fontWeight:700,textAlign:"center",marginBottom:8 }}>どちらが得点しましたか？</div>
              {fault===2&&<div style={{ fontSize:10,color:"#c0392b",textAlign:"center",marginBottom:8 }}>※ダブルフォルトのため、レシーブ側の得点ボタンを押してください</div>}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10 }}>
                {(()=>{
                  const leftIsServer = curServer===leftTeam;
                  const leftDisabled = fault===2 && leftIsServer;
                  const rightDisabled = fault===2 && !leftIsServer;
                  return (
                    <>
                      {/* 左ボタン：若番=自チーム(緑)、遅番=相手(赤) */}
                      <button disabled={leftDisabled} style={{ height:70,background:isYounger?"#2ecc71":"#f97316",color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:leftDisabled?"not-allowed":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(46,204,113,0.35)":"0 3px 10px rgba(249,115,22,0.35)",opacity:leftDisabled?0.35:1 }} onClick={()=>{ if(!leftDisabled) addPoint(leftTeam); }}>
                        <span style={{ fontSize:22 }}>得点</span>
                        <span style={{ fontSize:11,opacity:0.9 }}>{leftClub||"自チーム"}</span>
                      </button>
                      {/* 右ボタン：若番=相手(オレンジ)、遅番=自チーム(緑) */}
                      <button disabled={rightDisabled} style={{ height:70,background:isYounger?"#f97316":"#2ecc71",color:C.white,border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:rightDisabled?"not-allowed":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,boxShadow:isYounger?"0 3px 10px rgba(249,115,22,0.35)":"0 3px 10px rgba(46,204,113,0.35)",opacity:rightDisabled?0.35:1 }} onClick={()=>{ if(!rightDisabled) addPoint(rightTeam); }}>
                        <span style={{ fontSize:22 }}>得点</span>
                        <span style={{ fontSize:11,opacity:0.9 }}>{rightClub||(isYounger?"相手":"自チーム")}</span>
                      </button>
                    </>
                  );
                })()}
              </div>

              {/* ★直前の記録 or 次の得点への反映（今チップが何を編集中か明示） */}
              {nonFaultPts.length>0 ? (()=>{
                const lp=nonFaultPts[nonFaultPts.length-1];
                const detailParts=[lp.player_name,lp.play_type&&getPlayLabel(lp.play_type),lp.result_type&&getResultLabel(lp.result_type),lp.side_type&&getSideLabel(lp.side_type)].filter(Boolean);
                return (
                  <div style={{ background:"#eef7ff",border:"1px solid #b8dcff",borderRadius:10,padding:"8px 12px",marginBottom:10,fontSize:11,color:"#2569b3" }}>
                    <div style={{ fontWeight:700 }}>✎ 直前の記録を編集中：{lp.scoring_team==="A"?teamALabel:teamBLabel} {lp.score_a_after}-{lp.score_b_after}</div>
                    <div style={{ marginTop:2,color:"#5b8bc9" }}>{detailParts.length>0?detailParts.join("・"):"選手・結果・プレイ内容は未選択"}</div>
                  </div>
                );
              })() : (()=>{
                const preParts=[selPlayer,selPlay&&getPlayLabel(selPlay),selResult&&getResultLabel(selResult),selSide&&getSideLabel(selSide)].filter(Boolean);
                return (
                  <div style={{ background:"#eef7ff",border:"1px solid #b8dcff",borderRadius:10,padding:"8px 12px",marginBottom:10,fontSize:11,color:"#2569b3" }}>
                    <div style={{ fontWeight:700 }}>✎ これから入る得点に反映されます</div>
                    <div style={{ marginTop:2,color:"#5b8bc9" }}>{preParts.length>0?preParts.join("・"):"選手・結果・プレイ内容は未選択"}</div>
                  </div>
                );
              })()}

              {/* ★選手 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>選手（任意）</div>
                <div>
                  {allPlayers.map(p=>{
                    const lp=nonFaultPts[nonFaultPts.length-1];
                    const isSel = nonFaultPts.length>0 ? lp?.player_name===p.name : selPlayerId===p.id;
                    return (
                      <span key={p.id} style={S.chip(isSel)} onClick={()=>{
                        if(nonFaultPts.length>0){ updateLastPoint("player_name",p.name); }
                        else if(selPlayerId===p.id){ setSelPlayer(null); setSelPlayerId(null); }
                        else { setSelPlayer(p.name); setSelPlayerId(p.id); }
                      }}>{p.name}</span>
                    );
                  })}
                </div>
              </div>

              {/* ★結果 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>結果（任意）</div>
                <div>
                  {RESULT_TYPES.map(r=>{
                    const lp=nonFaultPts[nonFaultPts.length-1];
                    const isSel = nonFaultPts.length>0 ? lp?.result_type===r.key : selResult===r.key;
                    return (
                      <span key={r.key} style={S.chip(isSel)} onClick={()=>{
                        if(nonFaultPts.length>0){ updateLastPoint("result_type",r.key); }
                        else { setSelResult(prev=>prev===r.key?null:r.key); }
                      }}>{r.label}</span>
                    );
                  })}
                </div>
              </div>

              {/* ★プレイ内容 */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:8 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>プレイ内容（任意）</div>
                <div>
                  {PLAY_TYPES.map(p=>{
                    const lp=nonFaultPts[nonFaultPts.length-1];
                    const isSel = nonFaultPts.length>0 ? lp?.play_type===p.key : selPlay===p.key;
                    return (
                      <span key={p.key} style={S.chip(isSel)} onClick={()=>{
                        if(nonFaultPts.length>0){ updateLastPoint("play_type",p.key); }
                        else { setSelPlay(prev=>prev===p.key?null:p.key); }
                      }}>{p.label}</span>
                    );
                  })}
                </div>
              </div>

              {/* ★フォア / バック */}
              <div style={{ background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 10px",marginBottom:10 }}>
                <div style={{ fontSize:10,color:C.textSec,fontWeight:700,marginBottom:6 }}>フォア / バック（任意）</div>
                <div>
                  {SIDE_TYPES.map(s=>{
                    const lp=nonFaultPts[nonFaultPts.length-1];
                    const isSel = nonFaultPts.length>0 ? lp?.side_type===s.key : selSide===s.key;
                    return (
                      <span key={s.key} style={S.chip(isSel)} onClick={()=>{
                        if(nonFaultPts.length>0){ updateLastPoint("side_type",s.key); }
                        else { setSelSide(prev=>prev===s.key?null:s.key); }
                      }}>{s.label}</span>
                    );
                  })}
                </div>
              </div>
              <button style={{ width:"100%",padding:11,background:"#f0f0f0",color:C.textSec,border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer" }} onClick={undo}>↩ 1つ前に戻す</button>
              {teamMatchId && (
                <button style={{ width:"100%",padding:11,background:"#fff3e0",color:"#b45309",border:"1px solid #fbbf24",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:8 }} onClick={()=>setSuspendConfirm(true)}>✕ 試合を中断する</button>
              )}

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
                          <td style={{ fontSize:10,color:team==="A"?C.teamA:C.teamB,fontWeight:700,paddingRight:8,whiteSpace:"nowrap" }}>{name}</td>
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

      {suspendConfirm && (
        <Modal onClose={()=>setSuspendConfirm(false)}>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>⏹️</div>
            <h3 style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>試合を中断しますか？</h3>
            <p style={{ fontSize:12, color:C.textSec, marginBottom:20 }}>現在のスコアが保存され、この試合は中断扱いになります。</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button style={{ padding:11, background:"#f0f0f0", color:C.text, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={()=>setSuspendConfirm(false)}>キャンセル</button>
              <button style={{ padding:11, background:"#b45309", color:C.white, border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }} onClick={async ()=>{
                setSuspendConfirm(false);
                const updated = { ...match, status:"finished" };
                persist(updated);
                onBack();
              }}>中断して終了</button>
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
        const winPlays = Object.entries(p.playsWin).sort((a,b)=>b[1]-a[1]);
        const errPlays = Object.entries(p.playsErr).sort((a,b)=>b[1]-a[1]);
        const hasGoals = p.team==="A" && !!goals; // ★目標は自チームのみ適用
        const pointDiff = p.winners - p.errors;
        const diffGood = hasGoals && goals.goal_point_diff!=null ? pointDiff >= goals.goal_point_diff : null;
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
                  ["得点差", pointDiff>=0?`+${pointDiff}`:`${pointDiff}`, diffGood===null?C.orange:(diffGood?C.accent:C.red)],
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
                      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
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
                      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
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
                        <div style={{ fontSize:10,fontWeight:700,color:good===false?C.red:C.accent,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
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
                        <div style={{ fontSize:10,fontWeight:700,color:good===false?C.red:C.accent,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
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
            <div key={i} style={{ background:c.type==="strength"?C.accentL:c.type==="warning"?C.redL:C.redL, border:`1px solid ${c.type==="strength"?C.accent:c.type==="warning"?C.red:C.red}`, borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ fontSize:11,fontWeight:700,color:c.type==="strength"?C.accent:c.type==="warning"?C.red:C.red,marginBottom:3 }}>{c.type==="strength"?"💪 強み":"⚠️ 課題"} — {c.player}</div>
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
      let newLinkedPlayerId = linkedPlayerId;

      // 選手として登録する場合：選手マスターに自動登録
      if (registerMode === "player") {
        const existing = roster.find(p => p.player_name === fullName && p.is_own_team);
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
          const found = refreshed.find(p => p.player_name === fullName && p.is_own_team);
          if (found) newLinkedPlayerId = found.id;
        }
      }

      await saveMyProfile({ name: fullName, school_id: schoolId, prefecture, gender_category: genderCategory, category, linked_player_id: newLinkedPlayerId, is_approved: true });
      setLinkedPlayerId(newLinkedPlayerId);
      setIsApproved(true);
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
                            const existing = roster.find(p => p.player_name === pname);
                            if (existing) { setLinkedPlayerId(existing.id); }
                            else {
                              await savePlayer({ player_name: pname, position: playerPosition, dominant_hand: playerHand, is_own_team: true });
                              const refreshed = await getPlayerRoster();
                              setRoster(refreshed);
                              const saved = refreshed.find(p => p.player_name === pname);
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
        <div style={{ background:"#f5f5f5", border:"1px solid #e0e0e0", borderRadius:10, padding:"10px 14px", fontSize:12, color:C.textSec, marginBottom:14 }}>
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
async function completeProfileRegistration(userId, payload) {
  const { error: profileErr } = await supabase.from("users").insert({
    id: userId,
    name: payload.fullName,
    school_id: payload.schoolId,
    prefecture: payload.prefecture,
    gender_category: payload.genderCategory,
    category: payload.category,
    is_approved: true,
  });
  if (profileErr) throw profileErr;

  if (payload.registerMode === "player") {
    const roster = await getPlayerRoster();
    const existing = roster.find(p => p.player_name === payload.fullName && p.is_own_team);
    if (existing) {
      await supabase.from("users").update({ linked_player_id: existing.id }).eq("id", userId);
    } else {
      await savePlayer({ player_name: payload.fullName, position: payload.playerPosition, dominant_hand: payload.playerHand, is_own_team: true });
      const refreshed = await getPlayerRoster();
      const saved = refreshed.find(p => p.player_name === payload.fullName && p.is_own_team);
      if (saved) await supabase.from("users").update({ linked_player_id: saved.id }).eq("id", userId);
    }
  }

  if (payload.registerMode === "guardian" && payload.childName) {
    const roster = await getPlayerRoster();
    const existing = roster.find(p => p.player_name === payload.childName && p.is_own_team);
    if (existing) {
      await supabase.from("users").update({ linked_player_id: existing.id }).eq("id", userId);
    } else {
      await savePlayer({ player_name: payload.childName, position: payload.childPosition, dominant_hand: payload.childHand, is_own_team: true });
      const refreshed = await getPlayerRoster();
      const saved = refreshed.find(p => p.player_name === payload.childName && p.is_own_team);
      if (saved) await supabase.from("users").update({ linked_player_id: saved.id }).eq("id", userId);
    }
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
  // 団体戦関連
  const [teamMatchId,  setTeamMatchId]  = useState(null);
  const [teamMatchEditId, setTeamMatchEditId] = useState(null);
  const [teamMatchOrderNum, setTeamMatchOrderNum] = useState(null);
  const [teamMatchCopyId, setTeamMatchCopyId] = useState(null); // コピー元の団体戦ID
  const [listMatchMode, setListMatchMode] = useState("individual");
  const [serveSelectForTeam, setServeSelectForTeam] = useState(null); // 団体戦サーブ選択 // 履歴画面のタブ状態


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
      setProfile(p);
      setProfileChecked(true);
    });
    return () => { cancelled = true; };
  }, [user]);

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

  // 団体戦画面
  if (screen==="teamMatchSetup") {
    return (
      <TeamMatchSetup
        editId={teamMatchEditId}
        copyId={teamMatchCopyId}
        onSave={id=>{ setTeamMatchId(id); setTeamMatchEditId(null); setTeamMatchCopyId(null); setScreen("teamMatchDetail"); }}
        onCancel={()=>{ setTeamMatchEditId(null); setTeamMatchCopyId(null); setListMatchMode("team"); setScreen("list"); }}
      />
    );
  }
  if (screen==="teamMatchDetail" && teamMatchId) {
    return (
      <TeamMatchDetail
        teamMatchId={teamMatchId}
        onBack={()=>{ setTeamMatchId(null); setListMatchMode("team"); setScreen("list"); }}
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
        onEdit={id=>{ setEditTargetId(id); setScreen("setup"); }}
        onNavigate={key=>{ recalcTeamMatchScore(teamMatchId); setTick(t=>t+1); setMatchId(null); goNav(key); }}
      />
    );
  }

  // ★下部ナビゲーション（ホーム/履歴/分析/マスター）の共通遷移ハンドラ
  function goNav(key) {
    // 現在表示中の画面と同じタブを押しても何もしない
    const screenMap = { home:"home", list:"list", stats:"stats", master:"master" };
    if (screen === screenMap[key]) return;
    if (key==="home") setScreen("home");
    else if (key==="list") setScreen("list");
    else if (key==="stats") setScreen("stats");
    else if (key==="master") setScreen("master");
  }

  if (screen==="home") {
    return (
      <HomeScreen
        onNew={()=>{ setCopySourceId(null); setEditTargetId(null); setInitMatchType(null); setPrevScreen("home"); setScreen("setup"); }}
        onNewTeamMatch={()=>{ setTeamMatchEditId(null); setScreen("teamMatchSetup"); }}
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
        onGroupMembers={()=>setScreen("groupMembers")}
        onGoalSettings={()=>setScreen("goalSettings")}
      />
    );
  }
  if (screen==="goalSettings") {
    return <GoalSettingsScreen onBack={()=>setScreen("master")} />;
  }
  if (screen==="groupMembers") {
    return <GroupMembersScreen onBack={()=>setScreen("master")} />;
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
        onSave={id=>{
          setCopySourceId(null);
          setInitMatchType(null);
          setEditTargetId(null);
          setMatchId(id);
          setPrevScreen("record");
          setScreen("record");
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
        onBack={async ()=>{ setScreen(prevScreen==="home" ? "home" : prevScreen==="teamMatchDetail" ? "teamMatchDetail" : "list"); setMatchId(null); await new Promise(r=>setTimeout(r,800)); setTick(t=>t+1); }}
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
      onStartScheduled={async (id, firstServer)=>{ try { await startScheduledMatch(id, firstServer); setMatchId(id); setPrevScreen("list"); setScreen("record"); setTick(t=>t+1); } catch(e) { alert("試合開始エラー: " + (e?.message || e)); } }}
      onProfile={()=>setScreen("profile")}
      onRoster={()=>setScreen("roster")}
      onSchoolAdmin={()=>setScreen("schoolAdmin")}
      onNavigate={goNav}
      initialFilter={listFilter}
      initialToast={listFilter==="scheduled" ? "📅 試合予定を登録しました！" : null}
      onOpenTeamMatch={id=>{ setTeamMatchId(id); setListMatchMode("team"); setScreen("teamMatchDetail"); }}
      onNewTeamMatch={()=>{ setTeamMatchEditId(null); setTeamMatchCopyId(null); setScreen("teamMatchSetup"); }}
      onCopyTeamMatch={id=>{ setTeamMatchCopyId(id); setTeamMatchEditId(null); setScreen("teamMatchSetup"); }}
      initialMatchMode={listMatchMode}
    />
  );
}
