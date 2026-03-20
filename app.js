(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────
    let match = null;

    function createPlayer(name) {
        return {
            name,
            runs: 0,
            balls: 0,
            fours: 0,
            sixes: 0,
            isOut: false,
            dismissal: "",
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
            history: [],
            isComplete: false,
        };
    }

    // ── Setup ──────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    $("start-match-btn").addEventListener("click", startMatch);

    function startMatch() {
        const team1 = $("team1-name").value.trim() || "Team A";
        const team2 = $("team2-name").value.trim() || "Team B";
        const oversLimit = parseInt($("overs-limit").value) || 20;
        const playersPerTeam = parseInt($("players-per-team").value) || 11;
        const tossWinner = document.querySelector('input[name="toss-winner"]:checked').value;
        const tossDecision = document.querySelector('input[name="toss-decision"]:checked').value;

        const team1Players = Array.from({ length: playersPerTeam }, (_, i) => `${team1} Player ${i + 1}`);
        const team2Players = Array.from({ length: playersPerTeam }, (_, i) => `${team2} Player ${i + 1}`);

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
        document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
        $(id).classList.add("active");
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

        if (bowler) {
            $("bowler-name").textContent = bowler.name;
            $("bowler-figures").textContent = bowler.figures();
        }

        renderThisOver(inn.thisOver);
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

    function currentInnings() {
        return match.innings[match.currentInnings];
    }

    // ── Scoring ────────────────────────────────────────────
    document.querySelectorAll(".btn-run").forEach((btn) => {
        btn.addEventListener("click", () => {
            const runs = parseInt(btn.dataset.runs);
            scoreRuns(runs);
        });
    });

    function scoreRuns(runs) {
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

        inn.thisOver.push({ label: String(runs), chipClass });

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
        const inn = currentInnings();
        const bowler = inn.bowlers[inn.currentBowlerIndex];

        inn.history.push(snapshot(inn));

        if (type === "wide") {
            const total = 1 + additionalRuns;
            inn.totalRuns += total;
            inn.extras.wides += total;
            bowler.runs += total;
            bowler.runsThisOver += total;
            inn.thisOver.push({ label: `Wd+${additionalRuns}`, chipClass: "ball-wide" });
            if (additionalRuns % 2 === 1) swapStrike(inn);
        } else if (type === "noball") {
            const total = 1 + additionalRuns;
            inn.totalRuns += total;
            inn.extras.noBalls += 1;
            bowler.runs += total;
            bowler.runsThisOver += total;
            const striker = inn.batsmen[inn.strikerIndex];
            striker.balls += 0; // no-ball doesn't count as a ball faced (optional)
            inn.thisOver.push({ label: `NB+${additionalRuns}`, chipClass: "ball-noball" });
            if (additionalRuns % 2 === 1) swapStrike(inn);
        } else if (type === "bye") {
            inn.totalRuns += additionalRuns;
            inn.extras.byes += additionalRuns;
            inn.totalBalls += 1;
            const striker = inn.batsmen[inn.strikerIndex];
            striker.balls += 1;
            bowler.runsThisOver += 0;
            inn.thisOver.push({ label: `B${additionalRuns}`, chipClass: "ball-bye" });
            if (additionalRuns % 2 === 1) swapStrike(inn);
            checkOverComplete(inn);
        } else if (type === "legbye") {
            inn.totalRuns += additionalRuns;
            inn.extras.legByes += additionalRuns;
            inn.totalBalls += 1;
            const striker = inn.batsmen[inn.strikerIndex];
            striker.balls += 1;
            bowler.runsThisOver += 0;
            inn.thisOver.push({ label: `LB${additionalRuns}`, chipClass: "ball-legbye" });
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

        inn.thisOver.push({ label: "W", chipClass: "ball-wicket" });

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
            batsmen: inn.batsmen.map((b) => ({ ...b })),
            bowlers: inn.bowlers.map((b) => ({ ...b })),
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
        inn.batsmen = snap.batsmen.map((b) => {
            const p = createPlayer(b.name);
            Object.assign(p, b);
            return p;
        });
        inn.bowlers = snap.bowlers.map((b) => {
            const bw = createBowler(b.name);
            Object.assign(bw, b);
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

            // Batting
            html += `<table class="scorecard-table"><tr><th>Batsman</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr>`;
            inn.batsmen.forEach((b) => {
                if (b.balls > 0 || b.isOut) {
                    const dismissal = b.isOut ? b.dismissal : "not out";
                    html += `<tr><td class="player-name">${b.name}<br><span class="dismissal">${dismissal}</span></td><td class="num">${b.runs}</td><td class="num">${b.balls}</td><td class="num">${b.fours}</td><td class="num">${b.sixes}</td><td class="num">${b.strikeRate()}</td></tr>`;
                }
            });
            html += `</table>`;

            const totalExtras = inn.extras.wides + inn.extras.noBalls + inn.extras.byes + inn.extras.legByes;
            html += `<div class="scorecard-extras">Extras: ${totalExtras} (wd ${inn.extras.wides}, nb ${inn.extras.noBalls}, b ${inn.extras.byes}, lb ${inn.extras.legByes})</div>`;

            // Bowling
            if (inn.bowlers.length > 0) {
                html += `<table class="scorecard-table bowling-table"><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr>`;
                inn.bowlers.forEach((bw) => {
                    const overs = bw.overs + "." + bw.ballsInOver;
                    html += `<tr><td>${bw.name}</td><td>${overs}</td><td>${bw.maidens}</td><td>${bw.runs}</td><td>${bw.wickets}</td><td>${bw.economy()}</td></tr>`;
                });
                html += `</table>`;
            }
        });
        return html;
    }

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
        showScreen("setup-screen");
    });
})();
