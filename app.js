(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────
    let match = null;
    let tournament = null; // { name, format, overs, playersPerTeam, teams: [{name, players:[]}], fixtures: [{team1, team2, result, winner, played}], pointsTable: {} }
    let currentFixtureIndex = -1;

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
            saveTournament();
            $("back-to-tournament-btn").classList.remove("hidden");
            $("team1-name").readOnly = false;
            $("team2-name").readOnly = false;
            $("overs-limit").readOnly = false;
            $("players-per-team").readOnly = false;
        } else {
            $("back-to-tournament-btn").classList.add("hidden");
        }

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
        match = null;
        showScreen("home-screen");
    });

    // ── Home Screen ─────────────────────────────────────────
    $("quick-match-btn").addEventListener("click", () => {
        tournament = null;
        currentFixtureIndex = -1;
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
                card.className = "fixture-card" + (fixture.played ? " fixture-completed" : "");
                let inner = `<div class="fixture-teams"><span class="fixture-team ${fixture.winner === fixture.team1 ? "fixture-winner" : ""}">${fixture.team1}</span><span class="fixture-vs">vs</span><span class="fixture-team ${fixture.winner === fixture.team2 ? "fixture-winner" : ""}">${fixture.team2}</span></div>`;
                if (fixture.played) {
                    inner += `<div class="fixture-result">${fixture.result}</div>`;
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

    $("back-to-home-from-dashboard-btn").addEventListener("click", () => {
        loadSavedTournaments();
        showScreen("home-screen");
    });
})();
