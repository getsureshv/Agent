(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────
    let match = null;
    let tournament = null;
    let currentFixtureIndex = -1;

    // ── Match Persistence ───────────────────────────────────
    function matchStorageKey() {
        if (tournament && currentFixtureIndex >= 0) {
            return "cricket_match_" + tournament.name + "_" + currentFixtureIndex;
        }
        return "cricket_match_quick";
    }

    function saveMatchState() {
        if (!match) return;
        const key = matchStorageKey();
        const data = {
            match: JSON.parse(JSON.stringify(match)),
            currentFixtureIndex,
            tournamentName: tournament ? tournament.name : null,
        };
        localStorage.setItem(key, JSON.stringify(data));
        // Also mark fixture as in-progress in tournament
        if (tournament && currentFixtureIndex >= 0) {
            const fixture = tournament.fixtures[currentFixtureIndex];
            if (!fixture.played) {
                fixture.inProgress = true;
                fixture.liveScore = buildLiveScoreSummary();
            }
            saveTournament();
        }
    }

    function buildLiveScoreSummary() {
        if (!match || !match.innings || match.innings.length === 0) return "";
        const inn = match.innings[match.currentInnings];
        let summary = inn.battingTeam + " " + inn.totalRuns + "/" + inn.totalWickets + " (" + formatOvers(inn.totalBalls) + " ov)";
        if (match.currentInnings === 1) {
            summary += " | Target: " + (match.innings[0].totalRuns + 1);
        }
        return summary;
    }

    function loadMatchState(key) {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        // Rebuild methods on batsmen and bowlers
        data.match.innings.forEach(inn => {
            inn.batsmen = inn.batsmen.map(b => {
                const p = createPlayer(b.name);
                Object.assign(p, b);
                p.ballHistory = b.ballHistory || [];
                return p;
            });
            inn.bowlers = inn.bowlers.map(b => {
                const bw = createBowler(b.name);
                Object.assign(bw, b);
                bw.overHistory = (b.overHistory || []).map(o => ({ balls: [...o.balls], runs: o.runs }));
                bw.currentOverBalls = b.currentOverBalls || [];
                return bw;
            });
            // Rebuild history entries too
            inn.history = (inn.history || []).map(snap => {
                snap.batsmen = snap.batsmen.map(b => {
                    const p = createPlayer(b.name);
                    Object.assign(p, b);
                    p.ballHistory = b.ballHistory || [];
                    return p;
                });
                snap.bowlers = snap.bowlers.map(b => {
                    const bw = createBowler(b.name);
                    Object.assign(bw, b);
                    bw.overHistory = (b.overHistory || []).map(o => ({ balls: [...o.balls], runs: o.runs }));
                    bw.currentOverBalls = b.currentOverBalls || [];
                    return bw;
                });
                return snap;
            });
        });
        return data;
    }

    function clearMatchState() {
        const key = matchStorageKey();
        localStorage.removeItem(key);
        // Clear in-progress flag on fixture
        if (tournament && currentFixtureIndex >= 0) {
            const fixture = tournament.fixtures[currentFixtureIndex];
            delete fixture.inProgress;
            delete fixture.liveScore;
            saveTournament();
        }
    }

    function createPlayer(name) {
        return {
            name,
            runs: 0,
            balls: 0,
            fours: 0,
            sixes: 0,
            isOut: false,
            dismissal: "",
            ballHistory: [],
            strikeRate() {
                return this.balls > 0 ? ((this.runs / this.balls) * 100).toFixed(1) : "0.0";
            },
        };
    }

    function createBowler(name) {
        return {
            name,
            overs: 0,
            ballsInOver: 0,
            maidens: 0,
            runs: 0,
            wickets: 0,
            runsThisOver: 0,
            overHistory: [],
            currentOverBalls: [],
            figures() {
                const o = this.overs + "." + this.ballsInOver;
                return `${o}-${this.maidens}-${this.runs}-${this.wickets}`;
            },
            economy() {
                const totalBalls = this.overs * 6 + this.ballsInOver;
                return totalBalls > 0 ? ((this.runs / totalBalls) * 6).toFixed(2) : "0.00";
            },
        };
    }

    function createInnings(battingTeamName, bowlingTeamName, battingPlayers, bowlingPlayers, oversLimit) {
        return {
            battingTeam: battingTeamName,
            bowlingTeam: bowlingTeamName,
            totalRuns: 0,
            totalWickets: 0,
            totalBalls: 0,
            extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
            oversLimit,
            batsmen: battingPlayers.map((n) => createPlayer(n)),
            bowlers: [],
            bowlingNames: bowlingPlayers,
            strikerIndex: 0,
            nonStrikerIndex: 1,
            currentBowlerIndex: -1,
            thisOver: [],
            lastOver: [],
            lastOverRuns: 0,
            history: [],
            isComplete: false,
        };
    }

    // ── Setup ──────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    // Update toss radio labels when team names change
    $("team1-name").addEventListener("input", updateTossLabels);
    $("team2-name").addEventListener("input", updateTossLabels);

    function updateTossLabels() {
        const t1 = $("team1-name").value.trim() || "Team A";
        const t2 = $("team2-name").value.trim() || "Team B";
        const radio1 = $("toss-team1-label").querySelector("input");
        const radio2 = $("toss-team2-label").querySelector("input");
        $("toss-team1-label").innerHTML = "";
        $("toss-team1-label").appendChild(radio1);
        $("toss-team1-label").append(" " + t1);
        $("toss-team2-label").innerHTML = "";
        $("toss-team2-label").appendChild(radio2);
        $("toss-team2-label").append(" " + t2);
    }

    // Step 1: Setup -> Player entry
    $("next-to-players-btn").addEventListener("click", goToPlayerEntry);

    function goToPlayerEntry() {
        const team1 = $("team1-name").value.trim() || "Team A";
        const team2 = $("team2-name").value.trim() || "Team B";
        const playersPerTeam = parseInt($("players-per-team").value) || 11;

        $("team1-players-heading").textContent = team1;
        $("team2-players-heading").textContent = team2;

        buildPlayerInputs("team1-player-inputs", team1, playersPerTeam);
        buildPlayerInputs("team2-player-inputs", team2, playersPerTeam);

        showScreen("players-screen");
    }

    function buildPlayerInputs(containerId, teamName, count) {
        const container = $(containerId);
        container.innerHTML = "";
        for (let i = 0; i < count; i++) {
            const row = document.createElement("div");
            row.className = "player-input-row";
            row.innerHTML = `<span>${i + 1}.</span><input type="text" placeholder="${teamName} Player ${i + 1}" value="">`;
            container.appendChild(row);
        }
    }

    function readPlayerNames(containerId, teamName, count) {
        const inputs = $(containerId).querySelectorAll("input");
        return Array.from(inputs).map((inp, i) => inp.value.trim() || `${teamName} Player ${i + 1}`);
    }

    $("back-to-setup-btn").addEventListener("click", () => showScreen("setup-screen"));

    // Step 2: Player entry -> Start match
    $("start-match-btn").addEventListener("click", startMatch);

    function startMatch() {
        const team1 = $("team1-name").value.trim() || "Team A";
        const team2 = $("team2-name").value.trim() || "Team B";
        const oversLimit = parseInt($("overs-limit").value) || 20;
        const playersPerTeam = parseInt($("players-per-team").value) || 11;
        const tossWinner = document.querySelector('input[name="toss-winner"]:checked').value;
        const tossDecision = document.querySelector('input[name="toss-decision"]:checked').value;

        const team1Players = readPlayerNames("team1-player-inputs", team1, playersPerTeam);
        const team2Players = readPlayerNames("team2-player-inputs", team2, playersPerTeam);

        let battingFirst, bowlingFirst, battingPlayers, bowlingPlayers;
        if (tossWinner === "team1") {
            if (tossDecision === "bat") {
                battingFirst = team1; bowlingFirst = team2;
                battingPlayers = team1Players; bowlingPlayers = team2Players;
            } else {
                battingFirst = team2; bowlingFirst = team1;
                battingPlayers = team2Players; bowlingPlayers = team1Players;
            }
        } else {
            if (tossDecision === "bat") {
                battingFirst = team2; bowlingFirst = team1;
                battingPlayers = team2Players; bowlingPlayers = team1Players;
            } else {
                battingFirst = team1; bowlingFirst = team2;
                battingPlayers = team1Players; bowlingPlayers = team2Players;
            }
        }

        match = {
            team1, team2, oversLimit, playersPerTeam,
            innings: [],
            currentInnings: 0,
            battingFirstTeam: battingFirst,
            bowlingFirstTeam: bowlingFirst,
            team1Players, team2Players,
        };

        match.innings.push(createInnings(battingFirst, bowlingFirst, battingPlayers, bowlingPlayers, oversLimit));
        showScreen("scoring-screen");
        promptNewBowler();
        updateDisplay();
    }

    // ── Screen Management ──────────────────────────────────
    function showScreen(id) {
        // Unlock fields when leaving setup in non-tournament mode
        if (id !== "setup-screen" && !tournament) {
            $("team1-name").readOnly = false;
            $("team2-name").readOnly = false;
            $("overs-limit").readOnly = false;
            $("players-per-team").readOnly = false;
        }
        document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
        $(id).classList.add("active");
        // Show/hide tournament nav on scoring screen
        if (id === "scoring-screen" && tournament && currentFixtureIndex >= 0) {
            $("scoring-back-to-tournament-btn").classList.remove("hidden");
        } else {
            $("scoring-back-to-tournament-btn").classList.add("hidden");
        }
        // Pre-fill tournament player names
        if (id === "players-screen" && tournament && tournament._pendingTeam1Players) {
            setTimeout(() => {
                const t1Inputs = $("team1-player-inputs").querySelectorAll("input");
                const t2Inputs = $("team2-player-inputs").querySelectorAll("input");
                if (tournament._pendingTeam1Players) {
                    tournament._pendingTeam1Players.forEach((name, i) => { if (t1Inputs[i]) t1Inputs[i].value = name; });
                }
                if (tournament._pendingTeam2Players) {
                    tournament._pendingTeam2Players.forEach((name, i) => { if (t2Inputs[i]) t2Inputs[i].value = name; });
                }
            }, 0);
        }
    }

    // ── Display Updates ────────────────────────────────────
    function updateDisplay() {
        const inn = currentInnings();
        const striker = inn.batsmen[inn.strikerIndex];
        const nonStriker = inn.batsmen[inn.nonStrikerIndex];
        const bowler = inn.currentBowlerIndex >= 0 ? inn.bowlers[inn.currentBowlerIndex] : null;

        $("innings-indicator").textContent = match.currentInnings === 0 ? "1st Innings" : "2nd Innings";
        $("batting-team-name").textContent = inn.battingTeam;
        $("total-score").textContent = `${inn.totalRuns}/${inn.totalWickets}`;
        $("overs-display").textContent = `(${formatOvers(inn.totalBalls)} ov)`;

        const crr = inn.totalBalls > 0 ? ((inn.totalRuns / inn.totalBalls) * 6).toFixed(2) : "0.00";
        $("current-rr").textContent = crr;

        if (match.currentInnings === 1) {
            const target = match.innings[0].totalRuns + 1;
            const remaining = target - inn.totalRuns;
            const ballsLeft = inn.oversLimit * 6 - inn.totalBalls;
            const rrr = ballsLeft > 0 ? ((remaining / ballsLeft) * 6).toFixed(2) : "0.00";
            $("target-info").classList.remove("hidden");
            $("target-score").textContent = target;
            $("required-rr").textContent = rrr;
        } else {
            $("target-info").classList.add("hidden");
        }

        $("striker-name").textContent = striker.name;
        $("striker-score").textContent = `${striker.runs} (${striker.balls})`;
        $("non-striker-name").textContent = nonStriker.name;
        $("non-striker-score").textContent = `${nonStriker.runs} (${nonStriker.balls})`;

        // Highlight on-strike batsman
        $("striker-row").classList.add("on-strike");
        $("non-striker-row").classList.remove("on-strike");

        if (bowler) {
            $("bowler-name").textContent = bowler.name;
            $("bowler-figures").textContent = bowler.figures();
        }

        // Extras display
        const wd = inn.extras.wides || 0;
        const nb = inn.extras.noBalls || 0;
        const by = inn.extras.byes || 0;
        const lb = inn.extras.legByes || 0;
        $("extras-total").textContent = wd + nb + by + lb;
        $("extras-breakdown").textContent = `(wd ${wd}, nb ${nb}, b ${by}, lb ${lb})`;

        renderThisOver(inn.thisOver);
        renderLastOver(inn);

        // Auto-save match state
        saveMatchState();
    }

    function formatOvers(balls) {
        return Math.floor(balls / 6) + "." + (balls % 6);
    }

    function renderThisOver(balls) {
        const container = $("this-over-balls");
        container.innerHTML = "";
        balls.forEach((b) => {
            const chip = document.createElement("span");
            chip.className = "ball-chip " + b.chipClass;
            chip.textContent = b.label;
            container.appendChild(chip);
        });
    }

    function renderLastOver(inn) {
        const section = $("last-over-section");
        if (inn.lastOver.length === 0) {
            section.style.display = "none";
            return;
        }
        section.style.display = "";
        $("last-over-summary").textContent = `${inn.lastOverRuns} runs`;
        const container = $("last-over-balls");
        container.innerHTML = "";
        inn.lastOver.forEach((b) => {
            const chip = document.createElement("span");
            chip.className = "ball-chip " + b.chipClass;
            chip.textContent = b.label;
            container.appendChild(chip);
        });
    }

    $("last-over-toggle").addEventListener("click", () => {
        const detail = $("last-over-detail");
        const arrow = $("toggle-arrow");
        detail.classList.toggle("hidden");
        arrow.classList.toggle("open");
    });

    function currentInnings() {
        return match.innings[match.currentInnings];
    }

    function addBallToOver(inn, bowler, ball) {
        inn.thisOver.push(ball);
        bowler.currentOverBalls.push(ball);
    }

    // ── Scoring ────────────────────────────────────────────
    document.querySelectorAll(".btn-run").forEach((btn) => {
        btn.addEventListener("click", () => {
            const runs = parseInt(btn.dataset.runs);
            scoreRuns(runs);
        });
    });

    function scoreRuns(runs) {
        if (isNaN(runs)) return;
        const inn = currentInnings();
        const striker = inn.batsmen[inn.strikerIndex];
        const bowler = inn.bowlers[inn.currentBowlerIndex];

        inn.history.push(snapshot(inn));

        striker.runs += runs;
        striker.balls += 1;
        if (runs === 4) striker.fours++;
        if (runs === 6) striker.sixes++;

        inn.totalRuns += runs;
        inn.totalBalls += 1;
        bowler.runs += runs;
        bowler.runsThisOver += runs;

        let chipClass = "ball-dot";
        if (runs === 0) chipClass = "ball-dot";
        else if (runs === 4) chipClass = "ball-four";
        else if (runs === 6) chipClass = "ball-six";
        else chipClass = "ball-run";

        const ball = { label: String(runs), chipClass };
        addBallToOver(inn, bowler, ball);
        striker.ballHistory.push(ball);

        if (runs % 2 === 1) swapStrike(inn);

        checkOverComplete(inn);
        checkInningsComplete(inn);
        updateDisplay();
    }

    // ── Extras ─────────────────────────────────────────────
    let pendingExtraType = null;

    $("wide-btn").addEventListener("click", () => {
        pendingExtraType = "wide";
        $("extras-modal-title").textContent = "Wide - Additional Runs";
        showModal("extras-modal");
    });

    $("noball-btn").addEventListener("click", () => {
        pendingExtraType = "noball";
        $("extras-modal-title").textContent = "No Ball - Additional Runs";
        showModal("extras-modal");
    });

    $("bye-btn").addEventListener("click", () => {
        pendingExtraType = "bye";
        $("extras-modal-title").textContent = "Bye - Runs Taken";
        showModal("extras-modal");
    });

    $("legbye-btn").addEventListener("click", () => {
        pendingExtraType = "legbye";
        $("extras-modal-title").textContent = "Leg Bye - Runs Taken";
        showModal("extras-modal");
    });

    document.querySelectorAll(".extras-runs-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const additionalRuns = parseInt(btn.dataset.extraRuns);
            processExtra(pendingExtraType, additionalRuns);
            hideModal("extras-modal");
        });
    });

    $("cancel-extras").addEventListener("click", () => hideModal("extras-modal"));

    function processExtra(type, additionalRuns) {
        if (isNaN(additionalRuns)) return;
        const inn = currentInnings();
        const bowler = inn.bowlers[inn.currentBowlerIndex];

        inn.history.push(snapshot(inn));

        if (type === "wide") {
            const total = 1 + additionalRuns;
            inn.totalRuns += total;
            inn.extras.wides += total;
            bowler.runs += total;
            bowler.runsThisOver += total;
            addBallToOver(inn, bowler, { label: `Wd+${additionalRuns}`, chipClass: "ball-wide" });
            if (additionalRuns % 2 === 1) swapStrike(inn);
        } else if (type === "noball") {
            const total = 1 + additionalRuns;
            inn.totalRuns += total;
            inn.extras.noBalls += total;
            bowler.runs += total;
            bowler.runsThisOver += total;
            const striker = inn.batsmen[inn.strikerIndex];
            if (additionalRuns > 0) {
                striker.runs += additionalRuns;
                if (additionalRuns === 4) striker.fours++;
                if (additionalRuns === 6) striker.sixes++;
            }
            const nbBall = { label: `NB+${additionalRuns}`, chipClass: "ball-noball" };
            addBallToOver(inn, bowler, nbBall);
            striker.ballHistory.push(nbBall);
            if (additionalRuns % 2 === 1) swapStrike(inn);
        } else if (type === "bye") {
            inn.totalRuns += additionalRuns;
            inn.extras.byes += additionalRuns;
            inn.totalBalls += 1;
            const striker = inn.batsmen[inn.strikerIndex];
            striker.balls += 1;
            bowler.runsThisOver += 0;
            const byeBall = { label: `B${additionalRuns}`, chipClass: "ball-bye" };
            addBallToOver(inn, bowler, byeBall);
            striker.ballHistory.push(byeBall);
            if (additionalRuns % 2 === 1) swapStrike(inn);
            checkOverComplete(inn);
        } else if (type === "legbye") {
            inn.totalRuns += additionalRuns;
            inn.extras.legByes += additionalRuns;
            inn.totalBalls += 1;
            const striker = inn.batsmen[inn.strikerIndex];
            striker.balls += 1;
            bowler.runsThisOver += 0;
            const lbBall = { label: `LB${additionalRuns}`, chipClass: "ball-legbye" };
            addBallToOver(inn, bowler, lbBall);
            striker.ballHistory.push(lbBall);
            if (additionalRuns % 2 === 1) swapStrike(inn);
            checkOverComplete(inn);
        }

        checkInningsComplete(inn);
        updateDisplay();
    }

    // ── Wickets ────────────────────────────────────────────
    $("wicket-btn").addEventListener("click", () => showModal("wicket-modal"));
    $("cancel-wicket").addEventListener("click", () => hideModal("wicket-modal"));

    document.querySelectorAll(".btn-wicket-type").forEach((btn) => {
        btn.addEventListener("click", () => {
            processWicket(btn.dataset.type);
            hideModal("wicket-modal");
        });
    });

    function processWicket(type) {
        const inn = currentInnings();
        const striker = inn.batsmen[inn.strikerIndex];
        const bowler = inn.bowlers[inn.currentBowlerIndex];

        inn.history.push(snapshot(inn));

        striker.isOut = true;
        striker.dismissal = formatDismissal(type, bowler.name);
        striker.balls += 1;
        inn.totalWickets += 1;
        inn.totalBalls += 1;

        if (["bowled", "caught", "lbw", "stumped", "hit_wicket"].includes(type)) {
            bowler.wickets += 1;
        }
        bowler.runsThisOver += 0;

        const wBall = { label: "W", chipClass: "ball-wicket" };
        addBallToOver(inn, bowler, wBall);
        striker.ballHistory.push(wBall);

        if (inn.totalWickets >= match.playersPerTeam - 1) {
            checkOverComplete(inn);
            checkInningsComplete(inn);
            updateDisplay();
            return;
        }

        // Prompt for new batsman
        promptNewBatsman(inn);
        checkOverComplete(inn);
        checkInningsComplete(inn);
        updateDisplay();
    }

    function formatDismissal(type, bowlerName) {
        const labels = {
            bowled: `b ${bowlerName}`,
            caught: `c & b ${bowlerName}`,
            lbw: `lbw ${bowlerName}`,
            run_out: "run out",
            stumped: `st ${bowlerName}`,
            hit_wicket: `hit wicket b ${bowlerName}`,
            retired: "retired",
        };
        return labels[type] || type;
    }

    function promptNewBatsman(inn) {
        const list = $("batsman-list");
        list.innerHTML = "";
        inn.batsmen.forEach((b, i) => {
            if (!b.isOut && i !== inn.nonStrikerIndex && i !== inn.strikerIndex) {
                const btn = document.createElement("button");
                btn.className = "btn btn-secondary";
                btn.textContent = b.name;
                btn.addEventListener("click", () => {
                    inn.strikerIndex = i;
                    hideModal("new-batsman-modal");
                    updateDisplay();
                });
                list.appendChild(btn);
            }
        });
        if (list.children.length > 0) {
            showModal("new-batsman-modal");
        }
    }

    // ── Bowler Selection ───────────────────────────────────
    function promptNewBowler() {
        const inn = currentInnings();
        const list = $("bowler-list");
        list.innerHTML = "";

        const lastBowlerName = inn.currentBowlerIndex >= 0 ? inn.bowlers[inn.currentBowlerIndex].name : null;

        inn.bowlingNames.forEach((name) => {
            if (name === lastBowlerName) return;
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary";
            btn.textContent = name;
            btn.addEventListener("click", () => {
                selectBowler(inn, name);
                hideModal("new-bowler-modal");
                updateDisplay();
            });
            list.appendChild(btn);
        });

        showModal("new-bowler-modal");
    }

    $("cancel-new-bowler").addEventListener("click", () => {
        // If no bowler selected yet, auto-select first available
        const inn = currentInnings();
        if (inn.currentBowlerIndex < 0) {
            selectBowler(inn, inn.bowlingNames[0]);
        }
        hideModal("new-bowler-modal");
        updateDisplay();
    });

    function selectBowler(inn, name) {
        let idx = inn.bowlers.findIndex((b) => b.name === name);
        if (idx === -1) {
            inn.bowlers.push(createBowler(name));
            idx = inn.bowlers.length - 1;
        }
        inn.currentBowlerIndex = idx;
    }

    // ── Over Management ────────────────────────────────────
    function checkOverComplete(inn) {
        if (inn.totalBalls > 0 && inn.totalBalls % 6 === 0) {
            const bowler = inn.bowlers[inn.currentBowlerIndex];
            bowler.overs += 1;
            bowler.ballsInOver = 0;

            if (bowler.runsThisOver === 0) bowler.maidens += 1;

            inn.lastOver = [...inn.thisOver];
            inn.lastOverRuns = bowler.runsThisOver;

            bowler.overHistory.push({ balls: [...bowler.currentOverBalls], runs: bowler.runsThisOver });
            bowler.currentOverBalls = [];
            bowler.runsThisOver = 0;

            inn.thisOver = [];
            swapStrike(inn);

            if (!inn.isComplete) {
                promptNewBowler();
            }
        } else if (inn.currentBowlerIndex >= 0) {
            inn.bowlers[inn.currentBowlerIndex].ballsInOver = inn.totalBalls % 6;
        }
    }

    function checkInningsComplete(inn) {
        const allOut = inn.totalWickets >= match.playersPerTeam - 1;
        const oversUp = inn.totalBalls >= inn.oversLimit * 6;
        const targetChased = match.currentInnings === 1 && inn.totalRuns > match.innings[0].totalRuns;

        if (allOut || oversUp || targetChased) {
            inn.isComplete = true;

            if (match.currentInnings === 0) {
                // Start second innings
                const battingPlayers = match.bowlingFirstTeam === match.team1 ? match.team1Players : match.team2Players;
                const bowlingPlayers = match.battingFirstTeam === match.team1 ? match.team1Players : match.team2Players;
                match.innings.push(createInnings(match.bowlingFirstTeam, match.battingFirstTeam, battingPlayers, bowlingPlayers, match.oversLimit));
                match.currentInnings = 1;
                setTimeout(() => {
                    promptNewBowler();
                    updateDisplay();
                }, 100);
            } else {
                endMatch();
            }
        }
    }

    function endMatch() {
        const first = match.innings[0];
        const second = match.innings[1];
        let resultText;

        if (second.totalRuns > first.totalRuns) {
            const wicketsLeft = match.playersPerTeam - 1 - second.totalWickets;
            resultText = `${second.battingTeam} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? "s" : ""}`;
        } else if (first.totalRuns > second.totalRuns) {
            const margin = first.totalRuns - second.totalRuns;
            resultText = `${first.battingTeam} won by ${margin} run${margin !== 1 ? "s" : ""}`;
        } else {
            resultText = "Match Tied!";
        }

        $("result-text").textContent = resultText;
        $("result-summary").innerHTML = buildResultSummary();

        // Record result in tournament
        if (tournament && currentFixtureIndex >= 0) {
            const fixture = tournament.fixtures[currentFixtureIndex];
            fixture.played = true;
            fixture.result = resultText;
            if (second.totalRuns > first.totalRuns) {
                fixture.winner = second.battingTeam;
            } else if (first.totalRuns > second.totalRuns) {
                fixture.winner = first.battingTeam;
            } else {
                fixture.winner = null;
            }
            const inn1BattingTeam = first.battingTeam;
            let team1Runs, team1Balls, team2Runs, team2Balls;
            if (inn1BattingTeam === fixture.team1) {
                team1Runs = first.totalRuns; team1Balls = first.totalBalls;
                team2Runs = second.totalRuns; team2Balls = second.totalBalls;
            } else {
                team2Runs = first.totalRuns; team2Balls = first.totalBalls;
                team1Runs = second.totalRuns; team1Balls = second.totalBalls;
            }
            fixture.matchData = { team1Runs, team1Balls, team2Runs, team2Balls };
            // Store score lines for display on fixture cards
            fixture.scoreSummary = match.innings.map(inn =>
                inn.battingTeam + ": " + inn.totalRuns + "/" + inn.totalWickets + " (" + formatOvers(inn.totalBalls) + " ov)"
            ).join(" | ");
            delete fixture.inProgress;
            delete fixture.liveScore;
            saveTournament();
            $("back-to-tournament-btn").classList.remove("hidden");
            $("team1-name").readOnly = false;
            $("team2-name").readOnly = false;
            $("overs-limit").readOnly = false;
            $("players-per-team").readOnly = false;
        } else {
            $("back-to-tournament-btn").classList.add("hidden");
        }

        clearMatchState();
        showScreen("result-screen");
    }

    function buildResultSummary() {
        let html = "";
        match.innings.forEach((inn, idx) => {
            html += `<p style="margin:8px 0;font-size:16px;">${inn.battingTeam}: <strong>${inn.totalRuns}/${inn.totalWickets}</strong> (${formatOvers(inn.totalBalls)} ov)</p>`;
        });
        return html;
    }

    // ── Undo ───────────────────────────────────────────────
    $("undo-btn").addEventListener("click", () => {
        const inn = currentInnings();
        if (inn.history.length === 0) return;
        restoreSnapshot(inn, inn.history.pop());
        updateDisplay();
    });

    function snapshot(inn) {
        return {
            totalRuns: inn.totalRuns,
            totalWickets: inn.totalWickets,
            totalBalls: inn.totalBalls,
            extras: { ...inn.extras },
            strikerIndex: inn.strikerIndex,
            nonStrikerIndex: inn.nonStrikerIndex,
            currentBowlerIndex: inn.currentBowlerIndex,
            thisOver: [...inn.thisOver],
            lastOver: [...inn.lastOver],
            lastOverRuns: inn.lastOverRuns,
            batsmen: inn.batsmen.map((b) => ({ ...b, ballHistory: [...b.ballHistory] })),
            bowlers: inn.bowlers.map((b) => ({
                ...b,
                overHistory: b.overHistory.map((o) => ({ balls: [...o.balls], runs: o.runs })),
                currentOverBalls: [...b.currentOverBalls],
            })),
        };
    }

    function restoreSnapshot(inn, snap) {
        inn.totalRuns = snap.totalRuns;
        inn.totalWickets = snap.totalWickets;
        inn.totalBalls = snap.totalBalls;
        inn.extras = { ...snap.extras };
        inn.strikerIndex = snap.strikerIndex;
        inn.nonStrikerIndex = snap.nonStrikerIndex;
        inn.currentBowlerIndex = snap.currentBowlerIndex;
        inn.thisOver = [...snap.thisOver];
        inn.lastOver = [...snap.lastOver];
        inn.lastOverRuns = snap.lastOverRuns;
        inn.batsmen = snap.batsmen.map((b) => {
            const p = createPlayer(b.name);
            Object.assign(p, b);
            p.ballHistory = [...b.ballHistory];
            return p;
        });
        inn.bowlers = snap.bowlers.map((b) => {
            const bw = createBowler(b.name);
            Object.assign(bw, b);
            bw.overHistory = b.overHistory.map((o) => ({ balls: [...o.balls], runs: o.runs }));
            bw.currentOverBalls = [...b.currentOverBalls];
            return bw;
        });
    }

    // ── Swap Batsmen ───────────────────────────────────────
    function swapStrike(inn) {
        const temp = inn.strikerIndex;
        inn.strikerIndex = inn.nonStrikerIndex;
        inn.nonStrikerIndex = temp;
    }

    $("swap-btn").addEventListener("click", () => {
        const inn = currentInnings();
        swapStrike(inn);
        updateDisplay();
    });

    // ── Batsman Detail Modal ─────────────────────────────
    $("striker-row").addEventListener("click", () => {
        const inn = currentInnings();
        showBatsmanDetail(inn.batsmen[inn.strikerIndex]);
    });

    $("non-striker-row").addEventListener("click", () => {
        const inn = currentInnings();
        showBatsmanDetail(inn.batsmen[inn.nonStrikerIndex]);
    });

    $("close-batsman-detail").addEventListener("click", () => hideModal("batsman-detail-modal"));

    function showBatsmanDetail(batsman) {
        $("batsman-detail-name").textContent = batsman.name;

        const sr = batsman.strikeRate();
        const statsHtml = `
            <div class="batsman-stats-grid">
                <div class="batsman-stat"><span class="stat-value">${batsman.runs}</span><span class="stat-label">Runs</span></div>
                <div class="batsman-stat"><span class="stat-value">${batsman.balls}</span><span class="stat-label">Balls</span></div>
                <div class="batsman-stat"><span class="stat-value">${batsman.fours}</span><span class="stat-label">4s</span></div>
                <div class="batsman-stat"><span class="stat-value">${batsman.sixes}</span><span class="stat-label">6s</span></div>
                <div class="batsman-stat"><span class="stat-value">${sr}</span><span class="stat-label">SR</span></div>
            </div>
            <div class="batsman-dismissal ${batsman.isOut ? "" : "not-out"}">${batsman.isOut ? batsman.dismissal : "Not Out"}</div>`;
        $("batsman-detail-figures").innerHTML = statsHtml;

        const container = $("batsman-ball-timeline");
        container.innerHTML = "";

        if (batsman.ballHistory.length === 0) {
            container.innerHTML = '<p style="color:#78909c;text-align:center;font-size:13px;">No balls faced yet</p>';
            showModal("batsman-detail-modal");
            return;
        }

        const heading = document.createElement("div");
        heading.className = "ball-timeline-heading";
        heading.textContent = "Ball-by-Ball Timeline";
        container.appendChild(heading);

        const timeline = document.createElement("div");
        timeline.className = "ball-timeline";
        batsman.ballHistory.forEach((b) => {
            const chip = document.createElement("span");
            chip.className = "ball-chip " + b.chipClass;
            chip.textContent = b.label;
            timeline.appendChild(chip);
        });
        container.appendChild(timeline);

        showModal("batsman-detail-modal");
    }

    // ── Bowler Detail Modal ────────────────────────────────
    $("bowler-panel").addEventListener("click", () => {
        const inn = currentInnings();
        if (inn.currentBowlerIndex < 0) return;
        const bowler = inn.bowlers[inn.currentBowlerIndex];
        showBowlerDetail(bowler);
    });

    $("close-bowler-detail").addEventListener("click", () => hideModal("bowler-detail-modal"));

    function showBowlerDetail(bowler) {
        $("bowler-detail-name").textContent = bowler.name;

        const statsHtml = `
            <div class="bowler-stats-grid">
                <div class="bowler-stat"><span class="stat-value">${bowler.overs}.${bowler.ballsInOver}</span><span class="stat-label">Overs</span></div>
                <div class="bowler-stat"><span class="stat-value">${bowler.maidens}</span><span class="stat-label">Maidens</span></div>
                <div class="bowler-stat"><span class="stat-value">${bowler.runs}</span><span class="stat-label">Runs</span></div>
                <div class="bowler-stat"><span class="stat-value">${bowler.wickets}</span><span class="stat-label">Wickets</span></div>
                <div class="bowler-stat"><span class="stat-value">${bowler.economy()}</span><span class="stat-label">Economy</span></div>
            </div>`;
        $("bowler-detail-figures").innerHTML = statsHtml;

        const container = $("bowler-over-history");
        container.innerHTML = "";

        if (bowler.overHistory.length === 0 && bowler.currentOverBalls.length === 0) {
            container.innerHTML = '<p style="color:#78909c;text-align:center;font-size:13px;margin-top:12px;">No balls bowled yet</p>';
            showModal("bowler-detail-modal");
            return;
        }

        const heading = document.createElement("div");
        heading.className = "over-history-heading";
        heading.textContent = "Over-by-Over Breakdown";
        container.appendChild(heading);

        bowler.overHistory.forEach((ov, i) => {
            container.appendChild(buildOverRow(`Over ${i + 1}`, ov.balls, ov.runs));
        });

        if (bowler.currentOverBalls.length > 0) {
            container.appendChild(buildOverRow("Current", bowler.currentOverBalls, bowler.runsThisOver));
        }

        showModal("bowler-detail-modal");
    }

    function buildOverRow(label, balls, runs) {
        const row = document.createElement("div");
        row.className = "bowler-over-row";

        const lbl = document.createElement("span");
        lbl.className = "bowler-over-label";
        lbl.textContent = label;
        row.appendChild(lbl);

        const ballsContainer = document.createElement("div");
        ballsContainer.className = "bowler-over-balls";
        balls.forEach((b) => {
            const chip = document.createElement("span");
            chip.className = "ball-chip " + b.chipClass;
            chip.textContent = b.label;
            ballsContainer.appendChild(chip);
        });
        row.appendChild(ballsContainer);

        const runsSpan = document.createElement("span");
        runsSpan.className = "bowler-over-runs";
        runsSpan.textContent = `${runs}r`;
        row.appendChild(runsSpan);

        return row;
    }

    // ── Scorecard Modal ────────────────────────────────────
    $("scorecard-btn").addEventListener("click", () => {
        $("scorecard-content").innerHTML = buildScorecard();
        showModal("scorecard-modal");
    });

    $("close-scorecard").addEventListener("click", () => hideModal("scorecard-modal"));

    function buildScorecard() {
        let html = "";
        match.innings.forEach((inn, idx) => {
            html += `<div class="scorecard-team-header">${inn.battingTeam} - ${inn.totalRuns}/${inn.totalWickets} (${formatOvers(inn.totalBalls)} ov)</div>`;

            // Batting - batsmen who batted
            html += `<table class="scorecard-table"><tr><th>Batsman</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr>`;
            const dnbList = [];
            inn.batsmen.forEach((b, bIdx) => {
                if (b.balls > 0 || b.isOut) {
                    const dismissal = b.isOut ? b.dismissal : "not out";
                    html += `<tr class="scorecard-clickable" data-type="batsman" data-innings="${idx}" data-index="${bIdx}"><td class="player-name">${b.name}<br><span class="dismissal">${dismissal}</span></td><td class="num">${b.runs}</td><td class="num">${b.balls}</td><td class="num">${b.fours}</td><td class="num">${b.sixes}</td><td class="num">${b.strikeRate()}</td></tr>`;
                } else {
                    dnbList.push(b.name);
                }
            });
            html += `</table>`;
            if (dnbList.length > 0) {
                html += `<div class="scorecard-dnb">Did not bat: ${dnbList.join(", ")}</div>`;
            }

            const wd = inn.extras.wides || 0;
            const nb = inn.extras.noBalls || 0;
            const by = inn.extras.byes || 0;
            const lb = inn.extras.legByes || 0;
            const totalExtras = wd + nb + by + lb;
            html += `<div class="scorecard-extras">Extras: ${totalExtras} (wd ${wd}, nb ${nb}, b ${by}, lb ${lb})</div>`;

            // Bowling
            if (inn.bowlers.length > 0) {
                html += `<table class="scorecard-table bowling-table"><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr>`;
                inn.bowlers.forEach((bw, bwIdx) => {
                    const overs = bw.overs + "." + bw.ballsInOver;
                    html += `<tr class="scorecard-clickable" data-type="bowler" data-innings="${idx}" data-index="${bwIdx}"><td>${bw.name}</td><td>${overs}</td><td>${bw.maidens}</td><td>${bw.runs}</td><td>${bw.wickets}</td><td>${bw.economy()}</td></tr>`;
                });
                html += `</table>`;
            }
        });
        return html;
    }

    // Scorecard row click delegation
    $("scorecard-content").addEventListener("click", (e) => {
        const row = e.target.closest(".scorecard-clickable");
        if (!row) return;
        const innIdx = parseInt(row.dataset.innings);
        const index = parseInt(row.dataset.index);
        const inn = match.innings[innIdx];
        if (row.dataset.type === "batsman") {
            showBatsmanDetail(inn.batsmen[index]);
        } else if (row.dataset.type === "bowler") {
            showBowlerDetail(inn.bowlers[index]);
        }
    });

    // ── Modal Helpers ──────────────────────────────────────
    function showModal(id) {
        $(id).classList.remove("hidden");
    }

    function hideModal(id) {
        $(id).classList.add("hidden");
    }

    // ── New Match ──────────────────────────────────────────
    $("new-match-btn").addEventListener("click", () => {
        localStorage.removeItem("cricket_match_quick");
        match = null;
        showScreen("home-screen");
    });

    // ── Home Screen ─────────────────────────────────────────
    $("quick-match-btn").addEventListener("click", () => {
        tournament = null;
        currentFixtureIndex = -1;
        // Check for saved quick match
        const saved = loadMatchState("cricket_match_quick");
        if (saved && saved.match && !saved.match.innings[saved.match.currentInnings].isComplete) {
            if (confirm("Resume previous match?")) {
                match = saved.match;
                showScreen("scoring-screen");
                updateDisplay();
                return;
            } else {
                localStorage.removeItem("cricket_match_quick");
            }
        }
        showScreen("setup-screen");
    });

    $("new-tournament-btn").addEventListener("click", () => {
        showScreen("tournament-setup-screen");
    });

    $("back-to-home-btn").addEventListener("click", () => showScreen("home-screen"));

    // Load saved tournaments on startup
    function loadSavedTournaments() {
        const saved = localStorage.getItem("cricket_tournaments");
        const section = $("saved-tournaments-section");
        const list = $("saved-tournaments-list");
        if (!saved) { section.style.display = "none"; return; }
        const tournaments = JSON.parse(saved);
        if (tournaments.length === 0) { section.style.display = "none"; return; }
        section.style.display = "";
        list.innerHTML = "";
        tournaments.forEach((t, i) => {
            const card = document.createElement("div");
            card.className = "tournament-card";
            const played = t.fixtures.filter(f => f.played).length;
            card.innerHTML = `<div class="tournament-card-info"><strong>${t.name}</strong><span class="tournament-card-meta">${t.format === "league" ? "League" : "Knockout"} &middot; ${t.teams.length} teams &middot; ${played}/${t.fixtures.length} matches</span></div>`;
            const actions = document.createElement("div");
            actions.className = "tournament-card-actions";
            const resumeBtn = document.createElement("button");
            resumeBtn.className = "btn btn-primary";
            resumeBtn.textContent = "Resume";
            resumeBtn.addEventListener("click", () => {
                tournament = t;
                currentFixtureIndex = -1;
                showTournamentDashboard();
            });
            actions.appendChild(resumeBtn);
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "btn btn-danger-small";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => {
                tournaments.splice(i, 1);
                localStorage.setItem("cricket_tournaments", JSON.stringify(tournaments));
                loadSavedTournaments();
            });
            actions.appendChild(deleteBtn);
            card.appendChild(actions);
            list.appendChild(card);
        });
    }
    loadSavedTournaments();

    function saveTournament() {
        if (!tournament) return;
        const saved = JSON.parse(localStorage.getItem("cricket_tournaments") || "[]");
        const idx = saved.findIndex(t => t.name === tournament.name);
        if (idx >= 0) saved[idx] = tournament;
        else saved.push(tournament);
        localStorage.setItem("cricket_tournaments", JSON.stringify(saved));
    }

    // ── Tournament Setup ────────────────────────────────────
    $("next-to-teams-btn").addEventListener("click", () => {
        const name = $("tournament-name").value.trim();
        if (!name) { $("tournament-name").focus(); return; }
        tournament = {
            name,
            format: $("tournament-format").value,
            overs: parseInt($("tournament-overs").value) || 10,
            playersPerTeam: parseInt($("tournament-players").value) || 11,
            squadSize: parseInt($("tournament-squad-size").value) || 15,
            teams: [],
            fixtures: [],
        };
        renderTeamsList();
        showScreen("team-setup-screen");
    });

    // ── Team Setup ──────────────────────────────────────────
    $("back-to-tournament-setup-btn").addEventListener("click", () => showScreen("tournament-setup-screen"));

    $("add-team-btn").addEventListener("click", addTeam);
    $("new-team-name-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") addTeam();
    });

    function addTeam() {
        const inp = $("new-team-name-input");
        const name = inp.value.trim();
        if (!name) return;
        if (tournament.teams.some(t => t.name === name)) { inp.value = ""; return; }
        const players = [];
        const size = tournament.squadSize || tournament.playersPerTeam;
        for (let i = 0; i < size; i++) {
            players.push(`${name} Player ${i + 1}`);
        }
        tournament.teams.push({ name, players });
        inp.value = "";
        renderTeamsList();
    }

    let editingTeamIndex = -1;

    function renderTeamsList() {
        const list = $("teams-list");
        list.innerHTML = "";
        tournament.teams.forEach((team, i) => {
            const row = document.createElement("div");
            row.className = "team-row";
            row.innerHTML = `<span class="team-row-name">${team.name}</span><span class="team-row-meta">${team.players.length} players</span>`;
            const actions = document.createElement("div");
            actions.className = "team-row-actions";
            const editBtn = document.createElement("button");
            editBtn.className = "btn btn-secondary btn-small";
            editBtn.textContent = "Edit Players";
            editBtn.addEventListener("click", () => {
                editingTeamIndex = i;
                openTeamPlayersScreen(team);
            });
            actions.appendChild(editBtn);
            const removeBtn = document.createElement("button");
            removeBtn.className = "btn btn-danger-small btn-small";
            removeBtn.textContent = "Remove";
            removeBtn.addEventListener("click", () => {
                tournament.teams.splice(i, 1);
                renderTeamsList();
            });
            actions.appendChild(removeBtn);
            row.appendChild(actions);
            list.appendChild(row);
        });
        // Update generate button state
        const minTeams = tournament.format === "knockout" ? 2 : 3;
        $("generate-fixtures-btn").disabled = tournament.teams.length < minTeams;
    }

    function openTeamPlayersScreen(team) {
        $("team-players-heading").textContent = team.name + " - Squad";
        const container = $("team-players-inputs");
        container.innerHTML = "";
        const size = tournament.squadSize || tournament.playersPerTeam;
        for (let i = 0; i < size; i++) {
            const row = document.createElement("div");
            row.className = "player-input-row";
            row.innerHTML = `<span>${i + 1}.</span><input type="text" placeholder="${team.name} Player ${i + 1}" value="${team.players[i] || ""}">`;
            container.appendChild(row);
        }
        showScreen("team-players-screen");
    }

    $("back-to-teams-btn").addEventListener("click", () => showScreen("team-setup-screen"));

    $("save-team-players-btn").addEventListener("click", () => {
        if (editingTeamIndex < 0) return;
        const inputs = $("team-players-inputs").querySelectorAll("input");
        const team = tournament.teams[editingTeamIndex];
        team.players = Array.from(inputs).map((inp, i) => inp.value.trim() || `${team.name} Player ${i + 1}`);
        editingTeamIndex = -1;
        renderTeamsList();
        showScreen("team-setup-screen");
    });

    // ── Fixture Generation ──────────────────────────────────
    $("generate-fixtures-btn").addEventListener("click", () => {
        if (tournament.format === "league") {
            generateLeagueFixtures();
        } else {
            generateKnockoutFixtures();
        }
        saveTournament();
        showTournamentDashboard();
    });

    function generateLeagueFixtures() {
        tournament.fixtures = [];
        const teams = tournament.teams;
        for (let i = 0; i < teams.length; i++) {
            for (let j = i + 1; j < teams.length; j++) {
                tournament.fixtures.push({
                    team1: teams[i].name,
                    team2: teams[j].name,
                    played: false,
                    winner: null,
                    result: "",
                    round: 1,
                });
            }
        }
    }

    function generateKnockoutFixtures() {
        tournament.fixtures = [];
        const teams = [...tournament.teams];
        let round = 1;
        // If odd number, last team gets a bye
        for (let i = 0; i < teams.length - 1; i += 2) {
            tournament.fixtures.push({
                team1: teams[i].name,
                team2: teams[i + 1].name,
                played: false,
                winner: null,
                result: "",
                round,
            });
        }
        if (teams.length % 2 === 1) {
            // Last team gets auto-bye marker
            tournament.fixtures.push({
                team1: teams[teams.length - 1].name,
                team2: "BYE",
                played: true,
                winner: teams[teams.length - 1].name,
                result: "Bye",
                round,
            });
        }
    }

    // ── Tournament Dashboard ────────────────────────────────
    function showTournamentDashboard() {
        $("tournament-dashboard-title").textContent = tournament.name;
        renderFixtures();
        renderPointsTable();
        renderDashboardTeams();
        showScreen("tournament-dashboard-screen");
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            btn.classList.add("active");
            const tabId = "tab-" + btn.dataset.tab;
            document.getElementById(tabId).classList.add("active");
        });
    });

    function renderFixtures() {
        const list = $("fixtures-list");
        list.innerHTML = "";
        if (tournament.fixtures.length === 0) {
            list.innerHTML = '<p style="color:#78909c;text-align:center;">No fixtures yet</p>';
            return;
        }

        // Group by round for knockout
        const rounds = {};
        tournament.fixtures.forEach((f, i) => {
            const r = f.round || 1;
            if (!rounds[r]) rounds[r] = [];
            rounds[r].push({ fixture: f, index: i });
        });

        Object.keys(rounds).forEach(r => {
            if (tournament.format === "knockout") {
                const heading = document.createElement("div");
                heading.className = "fixture-round-heading";
                heading.textContent = "Round " + r;
                list.appendChild(heading);
            }
            rounds[r].forEach(({ fixture, index }) => {
                const card = document.createElement("div");
                const isInProgress = fixture.inProgress && !fixture.played;
                card.className = "fixture-card" + (fixture.played ? " fixture-completed" : "") + (isInProgress ? " fixture-in-progress" : "");
                let inner = `<div class="fixture-teams"><span class="fixture-team ${fixture.winner === fixture.team1 ? "fixture-winner" : ""}">${fixture.team1}</span><span class="fixture-vs">vs</span><span class="fixture-team ${fixture.winner === fixture.team2 ? "fixture-winner" : ""}">${fixture.team2}</span></div>`;
                if (fixture.played) {
                    // Show score summary if available
                    if (fixture.scoreSummary) {
                        inner += `<div class="fixture-score-summary">${fixture.scoreSummary}</div>`;
                    }
                    inner += `<div class="fixture-result">${fixture.result}</div>`;
                } else if (isInProgress) {
                    // Show live score and continue button
                    if (fixture.liveScore) {
                        inner += `<div class="fixture-live-score">${fixture.liveScore}</div>`;
                    }
                    inner += `<button class="btn btn-accent btn-small fixture-continue-btn" data-fixture="${index}">Continue</button>`;
                } else {
                    inner += `<button class="btn btn-primary btn-small fixture-play-btn" data-fixture="${index}">Play</button>`;
                }
                card.innerHTML = inner;
                list.appendChild(card);
            });
        });

        // Check if knockout needs next round
        if (tournament.format === "knockout") {
            const lastRound = Math.max(...tournament.fixtures.map(f => f.round || 1));
            const lastRoundFixtures = tournament.fixtures.filter(f => f.round === lastRound);
            const allPlayed = lastRoundFixtures.every(f => f.played);
            const winners = lastRoundFixtures.filter(f => f.winner).map(f => f.winner);
            if (allPlayed && winners.length > 1) {
                const nextRound = lastRound + 1;
                for (let i = 0; i < winners.length - 1; i += 2) {
                    tournament.fixtures.push({
                        team1: winners[i],
                        team2: winners[i + 1],
                        played: false, winner: null, result: "",
                        round: nextRound,
                    });
                }
                if (winners.length % 2 === 1) {
                    tournament.fixtures.push({
                        team1: winners[winners.length - 1],
                        team2: "BYE",
                        played: true,
                        winner: winners[winners.length - 1],
                        result: "Bye",
                        round: nextRound,
                    });
                }
                saveTournament();
                renderFixtures();
                return;
            }
            // Check for tournament winner
            if (allPlayed && winners.length === 1) {
                const banner = document.createElement("div");
                banner.className = "tournament-winner-banner";
                banner.textContent = winners[0] + " wins the tournament!";
                list.prepend(banner);
            }
        }

        // Attach play buttons
        list.querySelectorAll(".fixture-play-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const fIdx = parseInt(btn.dataset.fixture);
                startTournamentMatch(fIdx);
            });
        });
        // Attach continue buttons
        list.querySelectorAll(".fixture-continue-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const fIdx = parseInt(btn.dataset.fixture);
                resumeTournamentMatch(fIdx);
            });
        });
    }

    function renderPointsTable() {
        const container = $("points-table-container");
        if (tournament.format === "knockout") {
            container.innerHTML = '<p style="color:#78909c;text-align:center;padding:16px;">Points table is not applicable for knockout tournaments.</p>';
            return;
        }
        // Build points table
        const table = {};
        tournament.teams.forEach(t => {
            table[t.name] = { played: 0, won: 0, lost: 0, tied: 0, nrr: 0, points: 0, runsFor: 0, ballsFor: 0, runsAgainst: 0, ballsAgainst: 0 };
        });
        tournament.fixtures.forEach(f => {
            if (!f.played || !f.matchData) return;
            const md = f.matchData;
            const t1 = f.team1, t2 = f.team2;
            if (table[t1]) {
                table[t1].played++;
                table[t1].runsFor += md.team1Runs;
                table[t1].ballsFor += md.team1Balls;
                table[t1].runsAgainst += md.team2Runs;
                table[t1].ballsAgainst += md.team2Balls;
            }
            if (table[t2]) {
                table[t2].played++;
                table[t2].runsFor += md.team2Runs;
                table[t2].ballsFor += md.team2Balls;
                table[t2].runsAgainst += md.team1Runs;
                table[t2].ballsAgainst += md.team1Balls;
            }
            if (f.winner === t1) {
                if (table[t1]) { table[t1].won++; table[t1].points += 2; }
                if (table[t2]) table[t2].lost++;
            } else if (f.winner === t2) {
                if (table[t2]) { table[t2].won++; table[t2].points += 2; }
                if (table[t1]) table[t1].lost++;
            } else {
                // Tie
                if (table[t1]) { table[t1].tied++; table[t1].points += 1; }
                if (table[t2]) { table[t2].tied++; table[t2].points += 1; }
            }
        });
        // Calculate NRR
        Object.values(table).forEach(e => {
            const forRate = e.ballsFor > 0 ? (e.runsFor / e.ballsFor) * 6 : 0;
            const againstRate = e.ballsAgainst > 0 ? (e.runsAgainst / e.ballsAgainst) * 6 : 0;
            e.nrr = forRate - againstRate;
        });
        // Sort by points desc, then NRR desc
        const sorted = Object.entries(table).sort((a, b) => {
            if (b[1].points !== a[1].points) return b[1].points - a[1].points;
            return b[1].nrr - a[1].nrr;
        });

        let html = `<table class="points-table"><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>T</th><th>Pts</th><th>NRR</th></tr>`;
        sorted.forEach(([name, e], i) => {
            html += `<tr><td>${i + 1}</td><td class="pt-team">${name}</td><td>${e.played}</td><td>${e.won}</td><td>${e.lost}</td><td>${e.tied}</td><td class="pt-pts">${e.points}</td><td class="pt-nrr">${e.nrr >= 0 ? "+" : ""}${e.nrr.toFixed(3)}</td></tr>`;
        });
        html += `</table>`;
        container.innerHTML = html;
    }

    // ── Start Tournament Match ──────────────────────────────
    function resumeTournamentMatch(fixtureIndex) {
        currentFixtureIndex = fixtureIndex;
        const key = "cricket_match_" + tournament.name + "_" + fixtureIndex;
        const saved = loadMatchState(key);
        if (!saved) {
            // Fallback to starting fresh if no saved state
            startTournamentMatch(fixtureIndex);
            return;
        }
        match = saved.match;
        showScreen("scoring-screen");
        updateDisplay();
    }

    function startTournamentMatch(fixtureIndex) {
        currentFixtureIndex = fixtureIndex;
        const fixture = tournament.fixtures[fixtureIndex];
        const team1Data = tournament.teams.find(t => t.name === fixture.team1);
        const team2Data = tournament.teams.find(t => t.name === fixture.team2);
        const squadSize = tournament.squadSize || tournament.playersPerTeam;
        const playingXI = tournament.playersPerTeam;

        // If squad is larger than playing XI, show selection modal
        if (squadSize > playingXI && team1Data && team2Data) {
            showSquadSelectionModal(fixture, team1Data, team2Data, playingXI);
        } else {
            proceedToMatchSetup(fixture, team1Data, team2Data);
        }
    }

    function showSquadSelectionModal(fixture, team1Data, team2Data, playingXI) {
        $("squad-select-subtitle").textContent = `Pick ${playingXI} players per team`;
        $("squad-select-team1-heading").textContent = team1Data.name;
        $("squad-select-team2-heading").textContent = team2Data.name;

        buildSquadCheckboxes("squad-select-team1", team1Data.players, playingXI);
        buildSquadCheckboxes("squad-select-team2", team2Data.players, playingXI);

        updateConfirmSquadBtn(playingXI);
        showModal("squad-select-modal");
    }

    function buildSquadCheckboxes(containerId, players, maxSelect) {
        const container = $(containerId);
        container.innerHTML = "";
        players.forEach((name, i) => {
            const label = document.createElement("label");
            label.className = "squad-player-label";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = i < maxSelect; // pre-select first XI
            cb.dataset.index = i;
            cb.addEventListener("change", () => {
                const checked = container.querySelectorAll("input:checked").length;
                if (checked > maxSelect) {
                    cb.checked = false;
                    return;
                }
                updateConfirmSquadBtn(maxSelect);
            });
            label.appendChild(cb);
            const span = document.createElement("span");
            span.textContent = name;
            label.appendChild(span);
            container.appendChild(label);
        });
    }

    function updateConfirmSquadBtn(playingXI) {
        const t1Count = $("squad-select-team1").querySelectorAll("input:checked").length;
        const t2Count = $("squad-select-team2").querySelectorAll("input:checked").length;
        const btn = $("confirm-squad-btn");
        btn.disabled = t1Count !== playingXI || t2Count !== playingXI;
        btn.textContent = `Confirm (${t1Count} / ${t2Count})`;
    }

    $("confirm-squad-btn").addEventListener("click", () => {
        const fixture = tournament.fixtures[currentFixtureIndex];
        const team1Data = tournament.teams.find(t => t.name === fixture.team1);
        const team2Data = tournament.teams.find(t => t.name === fixture.team2);

        const t1Selected = getSelectedSquadPlayers("squad-select-team1", team1Data.players);
        const t2Selected = getSelectedSquadPlayers("squad-select-team2", team2Data.players);

        hideModal("squad-select-modal");
        proceedToMatchSetup(fixture, { name: team1Data.name, players: t1Selected }, { name: team2Data.name, players: t2Selected });
    });

    $("cancel-squad-btn").addEventListener("click", () => {
        hideModal("squad-select-modal");
    });

    function getSelectedSquadPlayers(containerId, allPlayers) {
        const checkboxes = $(containerId).querySelectorAll("input");
        const selected = [];
        checkboxes.forEach((cb, i) => {
            if (cb.checked) selected.push(allPlayers[i]);
        });
        return selected;
    }

    function proceedToMatchSetup(fixture, team1Data, team2Data) {
        // Pre-fill setup screen
        $("team1-name").value = fixture.team1;
        $("team2-name").value = fixture.team2;
        $("overs-limit").value = tournament.overs;
        $("players-per-team").value = tournament.playersPerTeam;
        $("team1-name").readOnly = true;
        $("team2-name").readOnly = true;
        $("overs-limit").readOnly = true;
        $("players-per-team").readOnly = true;
        updateTossLabels();
        showScreen("setup-screen");

        // Store selected playing XI for player entry screen
        tournament._pendingTeam1Players = team1Data ? team1Data.players.slice(0, tournament.playersPerTeam) : null;
        tournament._pendingTeam2Players = team2Data ? team2Data.players.slice(0, tournament.playersPerTeam) : null;
    }

    $("back-to-tournament-btn").addEventListener("click", () => {
        $("back-to-tournament-btn").classList.add("hidden");
        match = null;
        showTournamentDashboard();
    });

    $("scoring-back-to-tournament-btn").addEventListener("click", () => {
        // Save match state so it can be resumed
        saveMatchState();
        showTournamentDashboard();
    });

    $("back-to-home-from-dashboard-btn").addEventListener("click", () => {
        loadSavedTournaments();
        showScreen("home-screen");
    });

    // ── Dashboard Teams Tab ─────────────────────────────────
    function renderDashboardTeams() {
        const list = $("dashboard-teams-list");
        if (!list) return;
        list.innerHTML = "";
        if (!tournament) return;
        tournament.teams.forEach((team, i) => {
            const card = document.createElement("div");
            card.className = "dashboard-team-card";
            const header = document.createElement("div");
            header.className = "dashboard-team-header";
            const nameEl = document.createElement("strong");
            nameEl.textContent = team.name;
            header.appendChild(nameEl);
            const editBtn = document.createElement("button");
            editBtn.className = "btn btn-secondary btn-small";
            editBtn.textContent = "Edit Squad";
            editBtn.addEventListener("click", () => openRosterEditor(i));
            header.appendChild(editBtn);
            card.appendChild(header);

            const players = document.createElement("div");
            players.className = "dashboard-team-players";
            team.players.forEach(p => {
                const chip = document.createElement("span");
                chip.className = "dashboard-player-chip";
                chip.textContent = p;
                players.appendChild(chip);
            });
            card.appendChild(players);
            list.appendChild(card);
        });
    }

    // ── Roster Editor Modal ─────────────────────────────────
    let rosterEditingTeamIndex = -1;
    let rosterEditingPlayers = [];

    function openRosterEditor(teamIndex) {
        rosterEditingTeamIndex = teamIndex;
        const team = tournament.teams[teamIndex];
        rosterEditingPlayers = [...team.players];
        $("roster-editor-title").textContent = team.name + " - Squad";
        renderRosterEditorList();
        showModal("roster-editor-modal");
    }

    function renderRosterEditorList() {
        const container = $("roster-editor-players");
        container.innerHTML = "";
        rosterEditingPlayers.forEach((name, i) => {
            const row = document.createElement("div");
            row.className = "roster-player-row";
            const num = document.createElement("span");
            num.className = "roster-num";
            num.textContent = (i + 1) + ".";
            row.appendChild(num);
            const inp = document.createElement("input");
            inp.type = "text";
            inp.value = name;
            inp.addEventListener("input", (e) => {
                rosterEditingPlayers[i] = e.target.value;
            });
            row.appendChild(inp);
            const delBtn = document.createElement("button");
            delBtn.className = "btn-roster-delete";
            delBtn.textContent = "\u00d7";
            delBtn.title = "Remove player";
            delBtn.addEventListener("click", () => {
                rosterEditingPlayers.splice(i, 1);
                renderRosterEditorList();
            });
            row.appendChild(delBtn);
            container.appendChild(row);
        });
    }

    $("roster-add-btn").addEventListener("click", addRosterPlayer);
    $("roster-add-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") addRosterPlayer();
    });

    function addRosterPlayer() {
        const inp = $("roster-add-input");
        const name = inp.value.trim();
        if (!name) return;
        rosterEditingPlayers.push(name);
        inp.value = "";
        renderRosterEditorList();
    }

    $("save-roster-btn").addEventListener("click", () => {
        if (rosterEditingTeamIndex < 0) return;
        // Clean up empty names
        const cleaned = rosterEditingPlayers.map((n, i) => n.trim() || `Player ${i + 1}`);
        tournament.teams[rosterEditingTeamIndex].players = cleaned;
        saveTournament();
        hideModal("roster-editor-modal");
        renderDashboardTeams();
    });

    $("close-roster-editor").addEventListener("click", () => hideModal("roster-editor-modal"));

    // ── Cricket Rules Chat (ICC Playing Conditions + MCC Laws) ──
    const cricketRules = {
        basics: {
            title: "Basic Rules of Cricket",
            content: `<h3>Basic Rules (ICC / MCC Laws)</h3>
<p>Cricket is played between two teams of <strong>11 players</strong> each. Each team takes turns batting and bowling (an "innings").</p>
<ul>
<li>The <strong>batting team</strong> tries to score as many runs as possible</li>
<li>The <strong>bowling/fielding team</strong> tries to dismiss batsmen and restrict runs</li>
<li>An innings ends when <strong>10 wickets fall</strong> (all out) or the allotted overs are completed</li>
<li>Two batsmen are always at the crease — the <strong>striker</strong> faces the ball, the <strong>non-striker</strong> stands at the bowler's end</li>
<li>The bowler delivers <strong>6 legal balls per over</strong>, then a different bowler bowls from the other end</li>
<li>The same bowler <strong>cannot bowl consecutive overs</strong></li>
<li>The team batting second must <strong>surpass</strong> the first team's total to win</li>
<li>If the scores are level, the match is a <strong>Tie</strong> (in limited overs, a Super Over decides the winner in knockouts)</li>
</ul>
<p><strong>The pitch</strong> is 22 yards (20.12m) long. Stumps are 28 inches tall with two bails on top. The batting crease (popping crease) is 4 feet in front of the stumps.</p>`
        },
        scoring: {
            title: "Scoring & Runs",
            content: `<h3>How Runs Are Scored (ICC Rules)</h3>
<ul>
<li><strong>Running between wickets</strong> — batsmen complete runs by reaching the opposite crease. 1, 2, or 3 runs are common; 4 or 5 all-run is rare but legal</li>
<li><strong>Boundary four (4)</strong> — ball crosses the boundary rope after bouncing. Umpire signals by waving arm side to side</li>
<li><strong>Boundary six (6)</strong> — ball clears the boundary rope without bouncing. Umpire signals with both arms raised overhead</li>
<li><strong>Dot ball (0)</strong> — no run scored off the delivery</li>
<li><strong>Extras</strong> — wides, no balls, byes, and leg byes are added to the team total</li>
<li><strong>Overthrows</strong> — if a fielder's throw misses and crosses the boundary, all runs plus 4 are awarded</li>
<li><strong>Short run</strong> — if a batsman fails to ground the bat behind the crease, the umpire signals short run (taps shoulder) and that run is not counted</li>
<li><strong>Penalty runs</strong> — 5 penalty runs can be awarded for ball tampering, deliberate distraction, or damaging the pitch</li>
</ul>
<p><strong>Strike Rate</strong> = (Runs / Balls faced) x 100<br>
<strong>Run Rate</strong> = Runs scored per over (runs / overs)<br>
<strong>Required Run Rate</strong> = Runs needed / Overs remaining</p>`
        },
        dismissals: {
            title: "All 11 Dismissals",
            content: `<h3>Ways a Batsman Can Be Out (MCC Laws)</h3>
<p>There are <strong>11 methods of dismissal</strong> in the Laws of Cricket:</p>
<ul>
<li><strong>Bowled</strong> — the ball hits the stumps and dislodges the bails, whether or not it touches the bat/pad first</li>
<li><strong>Caught</strong> — a fielder catches the ball on the full after it touches the bat or glove. The catch must be taken cleanly before the ball bounces</li>
<li><strong>LBW</strong> — the ball would have hit the stumps but was intercepted by the batsman's body (see LBW topic for full details)</li>
<li><strong>Run Out</strong> — the stumps are broken by a fielder while the batsman is outside the crease during a run. Either batsman can be run out</li>
<li><strong>Stumped</strong> — the wicketkeeper breaks the stumps while the batsman is outside the crease, not attempting a run (usually off a spin delivery)</li>
<li><strong>Hit Wicket</strong> — the batsman dislodges the bails with their body, bat, or equipment while playing a shot or setting off for a run</li>
<li><strong>Obstructing the Field</strong> — a batsman deliberately blocks or distracts a fielder from making a play on the ball</li>
<li><strong>Hit the Ball Twice</strong> — the batsman intentionally hits the ball a second time (except to protect the stumps). Extremely rare</li>
<li><strong>Timed Out</strong> — the new batsman takes more than <strong>3 minutes</strong> to be ready to face after a wicket falls</li>
<li><strong>Retired Out</strong> — a batsman retires voluntarily and does not return. "Retired hurt" can return; "retired out" cannot</li>
<li><strong>Mankading (Run Out at non-striker's end)</strong> — the bowler removes the bails if the non-striker leaves the crease before the ball is delivered. Legal under Law 41.16</li>
</ul>
<p><em>On a <strong>Free Hit</strong>, the batsman can only be dismissed by run out, hitting the ball twice, or obstructing the field.</em></p>`
        },
        extras: {
            title: "Extras (ICC Rules)",
            content: `<h3>Types of Extras</h3>
<ul>
<li><strong>Wide Ball</strong> — umpire judges the ball passed too far from the batsman to play a normal shot. <strong>1 run</strong> added automatically + any runs completed. <strong>Does not count as a legal delivery</strong> — the bowler must re-bowl. In T20s the wide line is stricter than in ODIs/Tests. Umpire signal: both arms extended horizontally</li>
<li><strong>No Ball</strong> — bowler oversteps the front crease (most common), or bowls above waist height without bouncing, or throws rather than bowls. <strong>1 run</strong> added + any runs scored off the bat. <strong>Does not count as a legal delivery</strong>. In limited overs, the next ball is a <strong>Free Hit</strong>. Umpire signal: one arm extended horizontally</li>
<li><strong>Bye</strong> — the ball passes the batsman without touching bat or body, and batsmen complete runs. Counted as team extras, not individual runs. <strong>Counts as a legal delivery</strong>. Umpire signal: one arm raised above head</li>
<li><strong>Leg Bye</strong> — the ball hits the batsman's body (not glove/bat) and runs are taken. Only awarded if the batsman attempted a shot or tried to avoid the ball. <strong>Counts as a legal delivery</strong>. Umpire signal: touching knee with hand</li>
</ul>
<p><strong>No ball runs scored off the bat</strong> are credited to the batsman's individual score. All other extras count only toward the team total.</p>
<p><strong>Bouncer rules:</strong> In T20Is, bowlers are limited to <strong>1 bouncer per over</strong>. In ODIs, <strong>2 bouncers per over</strong>. In Tests, there is no limit.</p>`
        },
        freehit: {
            title: "Free Hit Rules",
            content: `<h3>Free Hit (ICC Playing Conditions)</h3>
<p>A Free Hit is awarded after <strong>every no ball</strong> in limited-overs cricket (ODIs and T20s). It does <strong>not apply in Test cricket</strong>.</p>
<ul>
<li>On a Free Hit delivery, the batsman <strong>cannot be dismissed</strong> except by: <strong>run out</strong>, <strong>hitting the ball twice</strong>, or <strong>obstructing the field</strong></li>
<li>The batsman cannot be bowled, caught, stumped, LBW, or hit wicket on a Free Hit</li>
<li>The umpire signals a Free Hit by <strong>circling one arm above the head</strong></li>
<li>Fielders <strong>cannot change positions</strong> from the previous delivery unless the batsmen crossed (striker changed)</li>
<li>If the Free Hit delivery is also a no ball or wide, the <strong>Free Hit carries over</strong> to the next ball</li>
<li>Originally (2007) only front-foot no balls gave a Free Hit. Since <strong>2015 ICC update</strong>, all no balls result in a Free Hit</li>
</ul>`
        },
        fielding: {
            title: "Fielding Positions",
            content: `<h3>Fielding Positions (ICC)</h3>
<p>The captain places 11 fielders (including bowler and wicketkeeper). Key positions:</p>
<ul>
<li><strong>Wicketkeeper</strong> — behind the stumps (only fielder allowed gloves)</li>
<li><strong>Slip(s) / Gully</strong> — close catchers on the off side, behind the batsman</li>
<li><strong>Point / Cover</strong> — off side, between square and mid-off</li>
<li><strong>Mid-off / Mid-on</strong> — straight, either side of the bowler</li>
<li><strong>Mid-wicket / Square Leg</strong> — on the leg side</li>
<li><strong>Fine Leg / Third Man</strong> — behind the wicket on leg/off side</li>
<li><strong>Long-on / Long-off / Deep mid-wicket</strong> — boundary fielders</li>
<li><strong>Short Leg / Silly Point</strong> — very close catching positions</li>
</ul>
<p><strong>ICC fielding restrictions:</strong></p>
<ul>
<li>No more than <strong>2 fielders</strong> behind square on the leg side at any time</li>
<li>A maximum of <strong>9 fielders</strong> on the field (excluding bowler and keeper) can be positioned anywhere within the restrictions</li>
</ul>`
        },
        formats: {
            title: "Match Formats (ICC)",
            content: `<h3>ICC Match Formats</h3>
<ul>
<li><strong>Test Cricket</strong> — up to 5 days, 2 innings per side, no over limit. No powerplays. Result: win, draw (time runs out), or tie (rare). The <strong>follow-on</strong> can be enforced if a team trails by 200+ runs (in 5-day Tests)</li>
<li><strong>ODI (50 overs)</strong> — each team bats once, max 50 overs. Each bowler limited to <strong>10 overs</strong>. Three powerplay phases. White ball, coloured clothing</li>
<li><strong>T20I (20 overs)</strong> — each team bats once, max 20 overs. Each bowler limited to <strong>4 overs</strong>. One powerplay (overs 1-6). Most explosive format</li>
<li><strong>T10 (10 overs)</strong> — each team bats once, max 10 overs. Each bowler limited to <strong>2 overs</strong>. Emerging format</li>
</ul>
<p><strong>Bowling limits per bowler:</strong> Test = unlimited | ODI = 10 overs | T20 = 4 overs | T10 = 2 overs</p>
<p><strong>Ball per innings:</strong> Test = unlimited | ODI = 300 balls | T20 = 120 balls | T10 = 60 balls</p>`
        },
        dls: {
            title: "DLS & Rain Rules",
            content: `<h3>Duckworth-Lewis-Stern Method (ICC)</h3>
<p>The DLS method is the ICC standard for setting revised targets in <strong>rain-affected limited-overs matches</strong>.</p>
<ul>
<li>It works on the principle that a team has two <strong>"resources"</strong> to score runs: <strong>overs remaining</strong> and <strong>wickets in hand</strong></li>
<li>A team at 50/0 in 10 overs has more resources than a team at 50/5 in 10 overs</li>
<li>When play is interrupted, DLS calculates the <strong>percentage of resources lost</strong> by each team and adjusts the target accordingly</li>
<li>The <strong>par score</strong> at any point tells you what the chasing team needs to be level</li>
<li>If the team batting second is ahead of the par score when play is abandoned, they win</li>
<li>A minimum of <strong>20 overs per side in ODIs</strong> and <strong>5 overs per side in T20s</strong> must be possible for a result</li>
</ul>
<p>For example: if Team A scores 250 in 50 overs, and rain reduces Team B's innings to 40 overs, DLS might set a revised target of 210 (not pro-rata 200).</p>`
        },
        powerplay: {
            title: "Powerplay Rules (ICC)",
            content: `<h3>ICC Powerplay & Fielding Restrictions</h3>
<p><strong>T20 International:</strong></p>
<ul>
<li><strong>Overs 1-6 (Powerplay):</strong> Max <strong>2 fielders</strong> outside the 30-yard circle</li>
<li><strong>Overs 7-20:</strong> Max <strong>5 fielders</strong> outside the 30-yard circle</li>
<li>In shortened T20 matches (rain), powerplay overs are now <strong>rounded to the nearest ball</strong> (2025 ICC update)</li>
</ul>
<p><strong>ODI (50 overs):</strong></p>
<ul>
<li><strong>Overs 1-10 (Powerplay 1):</strong> Max <strong>2 fielders</strong> outside the circle</li>
<li><strong>Overs 11-40 (Powerplay 2):</strong> Max <strong>4 fielders</strong> outside the circle</li>
<li><strong>Overs 41-50 (Powerplay 3):</strong> Max <strong>5 fielders</strong> outside the circle</li>
</ul>
<p><strong>Over-rate penalty (T20I):</strong> If the fielding team fails to bowl 20 overs within <strong>85 minutes</strong>, they must bring <strong>one extra fielder inside</strong> the circle for each over not completed in time.</p>
<p><strong>Test Cricket:</strong> No powerplays or fielding circle restrictions.</p>`
        },
        superover: {
            title: "Super Over Rules",
            content: `<h3>Super Over (ICC Playing Conditions)</h3>
<p>Used to decide the winner when a limited-overs match (ODI/T20) ends in a <strong>Tie</strong>:</p>
<ul>
<li>Each team faces <strong>1 over (6 balls)</strong></li>
<li>The team batting first in the main match bats first in the Super Over</li>
<li>Each team nominates <strong>3 players</strong> — 2 batsmen and 1 bowler</li>
<li>The team scoring the <strong>most runs</strong> in their Super Over wins</li>
<li>If the Super Over is also tied, <strong>another Super Over</strong> is played (continuous Super Overs, per ICC 2019 update)</li>
<li>The old "boundary countback" rule was <strong>scrapped in 2019</strong> after the controversial 2019 World Cup Final</li>
</ul>
<p>The Super Over only applies in <strong>knockout/tournament matches</strong>. League-stage ties may stand as ties depending on tournament rules.</p>`
        },
        drs: {
            title: "DRS (Decision Review)",
            content: `<h3>Decision Review System (ICC)</h3>
<p>DRS allows teams to challenge on-field umpire decisions using technology. First used in 2008 (India vs Sri Lanka).</p>
<ul>
<li>Each team gets <strong>1 unsuccessful review per innings</strong> (T20/ODI). Tests may allow 2-3</li>
<li>A successful review (decision overturned) is <strong>retained</strong> — you don't lose it</li>
<li>Reviews must be requested within <strong>15 seconds</strong> of the delivery. Captain signals with a "T" gesture</li>
<li>Only <strong>"Out" or "Not Out"</strong> decisions can be reviewed (not wides/no balls, except in some leagues like IPL)</li>
</ul>
<p><strong>Technology used:</strong></p>
<ul>
<li><strong>Hawk-Eye</strong> — ball-tracking that predicts trajectory for LBW decisions</li>
<li><strong>UltraEdge / Snickometer</strong> — detects if ball hit bat or pad first via sound waves</li>
<li><strong>Hot Spot</strong> — infrared imaging showing contact points</li>
</ul>
<p><strong>Umpire's Call:</strong> If ball-tracking shows the ball is clipping the stumps (within the margin of error), the original on-field decision stands. This preserves the umpire's authority.</p>`
        },
        nrr: {
            title: "Net Run Rate (NRR)",
            content: `<h3>Net Run Rate (ICC Tournament Rules)</h3>
<p><strong>NRR = (Runs scored / Overs faced) - (Runs conceded / Overs bowled)</strong></p>
<ul>
<li>A <strong>positive NRR</strong> means you score faster than you concede — better</li>
<li>Used as the <strong>primary tiebreaker</strong> when teams finish on equal points in league/group stages</li>
<li>If a team is <strong>bowled out</strong>, the full quota of overs is used (not the actual overs taken). This penalizes teams that collapse early</li>
<li>Winning by a large margin boosts your NRR significantly</li>
</ul>
<p><strong>Example:</strong> Team A scores 180/4 in 20 overs (rate: 9.00) and bowls out Team B for 120 in 18 overs (but counted as 20 overs, rate: 6.00). NRR for that match = 9.00 - 6.00 = +3.00</p>
<p>This app automatically calculates NRR for league tournaments in the Points Table.</p>`
        },
        lbw: {
            title: "LBW Explained (ICC)",
            content: `<h3>LBW — Leg Before Wicket</h3>
<p>First introduced in the Laws of Cricket in <strong>1774</strong>. One of the most complex and debated dismissals.</p>
<p><strong>Three conditions must ALL be met:</strong></p>
<ul>
<li><strong>1. Where did the ball pitch?</strong> — Must NOT pitch outside leg stump. Can pitch outside off stump or in line</li>
<li><strong>2. Where did it hit the pad?</strong> — Must be <strong>in line</strong> with the stumps. Exception: if the batsman offers <strong>no shot</strong>, it can hit outside off stump and still be out</li>
<li><strong>3. Would it have hit the stumps?</strong> — Ball-tracking (Hawk-Eye) must show the ball going on to hit the stumps</li>
</ul>
<p><strong>NOT out LBW if:</strong></p>
<ul>
<li>Ball pitched outside leg stump</li>
<li>Ball hit the pad outside off stump AND the batsman was playing a shot</li>
<li>Ball hit the bat first before hitting the pad</li>
<li>Ball was going over or missing the stumps</li>
</ul>
<p><strong>DRS and Umpire's Call:</strong> If fewer than 50% of the ball is hitting the stumps per Hawk-Eye, it's "Umpire's Call" — the on-field decision stands regardless of the review.</p>`
        },
        umpire: {
            title: "Umpire Signals",
            content: `<h3>Umpire Signals (MCC Laws)</h3>
<ul>
<li><strong>Out</strong> — raised index finger</li>
<li><strong>Not Out</strong> — arms waved across chest</li>
<li><strong>No Ball</strong> — one arm extended horizontally to the side</li>
<li><strong>Wide</strong> — both arms extended horizontally</li>
<li><strong>Boundary Four</strong> — arm waved back and forth in front of chest</li>
<li><strong>Boundary Six</strong> — both arms raised straight above head</li>
<li><strong>Bye</strong> — one open palm raised above the head</li>
<li><strong>Leg Bye</strong> — touches knee with hand</li>
<li><strong>Free Hit</strong> — circles one arm above the head</li>
<li><strong>Dead Ball</strong> — crosses both arms in front of waist</li>
<li><strong>TV Umpire Review</strong> — makes a rectangle/box shape with hands</li>
<li><strong>Penalty Runs</strong> — one hand placed on opposite shoulder</li>
<li><strong>Short Run</strong> — taps nearest shoulder with fingers</li>
<li><strong>New Ball</strong> — holds ball above head</li>
<li><strong>Revoke Last Signal</strong> — touches both shoulders with hands</li>
</ul>`
        },
    };

    $("chat-fab").addEventListener("click", () => {
        $("chat-panel").classList.toggle("hidden");
    });

    $("chat-panel-close").addEventListener("click", () => {
        $("chat-panel").classList.add("hidden");
    });

    document.querySelectorAll(".chat-topic-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const topic = btn.dataset.topic;
            showRuleTopic(topic);
        });
    });

    function showRuleTopic(topic) {
        const rule = cricketRules[topic];
        if (!rule) return;
        $("chat-search-results").classList.add("hidden");
        $("chat-topics").classList.add("hidden");
        $("chat-answer").classList.remove("hidden");
        $("chat-answer-content").innerHTML = rule.content;
    }

    $("chat-back-btn").addEventListener("click", () => {
        $("chat-answer").classList.add("hidden");
        $("chat-search-results").classList.add("hidden");
        $("chat-topics").classList.remove("hidden");
        $("chat-search-input").value = "";
    });

    // ── Chat Search ─────────────────────────────────────────
    // Build a flat searchable index from all rules
    function buildSearchIndex() {
        const index = [];
        Object.entries(cricketRules).forEach(([key, rule]) => {
            // Strip HTML tags to get plain text for searching
            const plain = rule.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            // Split into sentences/chunks for snippet extraction
            const sentences = plain.split(/(?<=[.!?])\s+|(?<=<\/li>)\s*/);
            index.push({ key, title: rule.title, plain, sentences });
        });
        return index;
    }

    const searchIndex = buildSearchIndex();

    $("chat-search-input").addEventListener("input", debounce(function () {
        const query = $("chat-search-input").value.trim().toLowerCase();
        if (query.length < 2) {
            $("chat-search-results").classList.add("hidden");
            $("chat-topics").classList.remove("hidden");
            $("chat-answer").classList.add("hidden");
            return;
        }
        performSearch(query);
    }, 250));

    $("chat-search-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const query = $("chat-search-input").value.trim().toLowerCase();
            if (query.length >= 2) performSearch(query);
        }
    });

    function debounce(fn, ms) {
        let timer;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, arguments), ms);
        };
    }

    function performSearch(query) {
        const results = [];
        const words = query.split(/\s+/).filter(w => w.length > 1);

        searchIndex.forEach(entry => {
            const lowerPlain = entry.plain.toLowerCase();
            // Score: count how many query words appear
            let score = 0;
            let matched = false;
            words.forEach(w => {
                if (lowerPlain.includes(w)) { score++; matched = true; }
            });
            // Boost if full phrase matches
            if (lowerPlain.includes(query)) score += 5;
            // Boost title matches
            if (entry.title.toLowerCase().includes(query)) score += 3;

            if (matched) {
                // Extract best snippet around first match
                const snippet = extractSnippet(entry.plain, words, 120);
                results.push({ key: entry.key, title: entry.title, score, snippet });
            }
        });

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        renderSearchResults(results, words);
    }

    function extractSnippet(text, words, maxLen) {
        const lower = text.toLowerCase();
        // Find the earliest match position
        let earliest = text.length;
        words.forEach(w => {
            const idx = lower.indexOf(w);
            if (idx >= 0 && idx < earliest) earliest = idx;
        });
        // Window around the match
        let start = Math.max(0, earliest - 30);
        let end = Math.min(text.length, start + maxLen);
        let snippet = text.substring(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < text.length) snippet += "...";
        return snippet;
    }

    function highlightWords(text, words) {
        let result = text;
        words.forEach(w => {
            const regex = new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
            result = result.replace(regex, "<mark>$1</mark>");
        });
        return result;
    }

    function renderSearchResults(results, words) {
        const container = $("chat-search-results");
        container.innerHTML = "";

        if (results.length === 0) {
            container.innerHTML = '<div class="chat-no-results">No matching rules found. Try different keywords.</div>';
            container.classList.remove("hidden");
            $("chat-topics").classList.add("hidden");
            $("chat-answer").classList.add("hidden");
            return;
        }

        results.forEach(r => {
            const card = document.createElement("div");
            card.className = "chat-search-result-card";
            card.innerHTML = `<div class="chat-search-result-title">${r.title}</div><div class="chat-search-result-snippet">${highlightWords(r.snippet, words)}</div>`;
            card.addEventListener("click", () => {
                showRuleTopic(r.key);
            });
            container.appendChild(card);
        });

        container.classList.remove("hidden");
        $("chat-topics").classList.add("hidden");
        $("chat-answer").classList.add("hidden");
    }
})();
