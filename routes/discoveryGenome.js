"use strict";

const express = require("express");
const genome = require("../lib/discoveryGenome");
const seeds = require("../lib/discoveryGenomeSeeds");
const graphs = require("../lib/graphs");
const programmeState = require("../lib/programmeState");
const programmeWorkflow = require("../lib/programmeWorkflow");
const reviewTrace = require("../lib/reviewTrace");

function message(err) {
  return String(err?.message || err || "Discovery Genome request failed.").slice(0, 300);
}

function createDiscoveryGenomeRouter({ checkCsrf, audit }) {
  const router = express.Router();
  router.use(express.json({ limit: "128kb" }));

  async function requireOwnedGraph(req, res) {
    const graphId = String(req.params.graphId || "");
    if (!graphId || !await graphs.checkGraphOwnership(req.user.id, graphId)) {
      res.status(404).json({ error: "Memory graph not found." });
      return null;
    }
    return graphId;
  }

  // Programme-state and follow-up-question bridge. The same routes are used by
  // browser sessions and the server-to-server MCP client, always tenant scoped.
  router.get("/graphs", async (req, res) => {
    try {
      res.json({ graphs: await graphs.getUserGraphs(req.user.id) });
    } catch (err) {
      console.error("[discovery-genome graphs]", message(err));
      res.status(500).json({ error: "Could not load memory graphs." });
    }
  });

  router.get("/graphs/:graphId/programme-state", async (req, res) => {
    try {
      const graphId = await requireOwnedGraph(req, res);
      if (!graphId) return;
      const snapshot = await programmeState.latestProgrammeStateSnapshot(req.user.id, graphId);
      res.json({ graph_id: graphId, snapshot });
    } catch (err) {
      console.error("[discovery-genome programme-state]", message(err));
      res.status(500).json({ error: "Could not load programme state." });
    }
  });

  router.post("/graphs/:graphId/programme-state/compile", checkCsrf, async (req, res) => {
    try {
      const graphId = await requireOwnedGraph(req, res);
      if (!graphId) return;
      const snapshot = await programmeWorkflow.compileAndSaveProgrammeState(req.user.id, graphId);
      audit(req.user.id, "programme_state_compiled", req, {
        graph_id: graphId,
        snapshot_id: snapshot.id,
        interface: req.genomeService ? "mcp" : "guided",
      });
      res.json({ graph_id: graphId, snapshot });
    } catch (err) {
      console.error("[discovery-genome compile-programme-state]", message(err));
      res.status(500).json({ error: "Could not compile programme state." });
    }
  });

  router.get("/graphs/:graphId/questions", async (req, res) => {
    try {
      const graphId = await requireOwnedGraph(req, res);
      if (!graphId) return;
      res.json({ graph_id: graphId, questions: await reviewTrace.listQuestions(req.user.id, graphId) });
    } catch (err) {
      console.error("[discovery-genome questions]", message(err));
      res.status(500).json({ error: "Could not load follow-up questions." });
    }
  });

  router.post("/graphs/:graphId/questions/generate", checkCsrf, async (req, res) => {
    try {
      const graphId = await requireOwnedGraph(req, res);
      if (!graphId) return;
      const generated = await programmeWorkflow.generateAndSaveQuestions(req.user.id, graphId);
      audit(req.user.id, "admissible_questions_generated", req, {
        graph_id: graphId,
        snapshot_id: generated.snapshot.id,
        question_count: generated.questions.length,
        interface: req.genomeService ? "mcp" : "guided",
      });
      res.json({ graph_id: graphId, ...generated });
    } catch (err) {
      console.error("[discovery-genome generate-questions]", message(err));
      res.status(500).json({ error: "Could not generate follow-up questions." });
    }
  });

  router.get("/operators", async (req, res) => {
    try {
      res.json({ operators: await genome.listOperators(req.user.id) });
    } catch (err) {
      console.error("[discovery-genome operators]", message(err));
      res.status(500).json({ error: "Could not load discovery operators." });
    }
  });

  router.post("/operators/seed", checkCsrf, async (req, res) => {
    try {
      const result = await seeds.seedDefaultOperators(req.user.id);
      audit(req.user.id, "discovery_operators_seeded", req, {
        created_count: result.created.length,
        skipped_count: result.skipped.length,
      });
      res.status(result.created.length ? 201 : 200).json(result);
    } catch (err) {
      res.status(400).json({ error: message(err) });
    }
  });

  router.post("/operators", checkCsrf, async (req, res) => {
    try {
      const operator = await genome.createOperator(req.user.id, req.body || {});
      audit(req.user.id, "discovery_operator_created", req, {
        operator_id: operator.id,
        operator_key: operator.operator_key,
        version: operator.version,
      });
      res.status(201).json({ operator });
    } catch (err) {
      res.status(400).json({ error: message(err) });
    }
  });

  router.post("/operators/:operatorId/freeze", checkCsrf, async (req, res) => {
    try {
      const operator = await genome.freezeOperator(
        req.user.id,
        req.params.operatorId,
        req.body?.expected_review_hash
      );
      audit(req.user.id, "discovery_operator_frozen", req, {
        operator_id: operator.id,
        contract_hash: operator.contract_hash,
      });
      res.json({ operator });
    } catch (err) {
      res.status(/not found/i.test(message(err)) ? 404 : 409).json({ error: message(err) });
    }
  });

  router.post("/operators/:operatorId/evidence", checkCsrf, async (req, res) => {
    try {
      const evidence = await genome.addOperatorEvidence(req.user.id, req.params.operatorId, req.body || {});
      audit(req.user.id, "discovery_operator_evidence_added", req, {
        operator_id: req.params.operatorId,
        evidence_id: evidence.id,
        case_id: evidence.case_id,
        outcome: evidence.outcome,
      });
      res.status(201).json({ evidence });
    } catch (err) {
      res.status(/not found/i.test(message(err)) ? 404 : 400).json({ error: message(err) });
    }
  });

  router.get("/tournaments", async (req, res) => {
    try {
      res.json({ tournaments: await genome.listTournaments(req.user.id) });
    } catch (err) {
      console.error("[discovery-genome tournaments]", message(err));
      res.status(500).json({ error: "Could not load discovery tournaments." });
    }
  });

  router.get("/tournaments/:tournamentId", async (req, res) => {
    try {
      res.json({
        tournament: await genome.getTournament(req.user.id, req.params.tournamentId),
      });
    } catch (err) {
      res.status(/not found/i.test(message(err)) ? 404 : 500).json({ error: message(err) });
    }
  });

  router.post("/tournaments", checkCsrf, async (req, res) => {
    try {
      const tournament = await genome.createTournament(req.user.id, req.body || {});
      audit(req.user.id, "discovery_tournament_created", req, { tournament_id: tournament.id });
      res.status(201).json({ tournament });
    } catch (err) {
      res.status(400).json({ error: message(err) });
    }
  });

  router.post("/tournaments/:tournamentId/entries", checkCsrf, async (req, res) => {
    try {
      const entry = await genome.addTournamentEntry(
        req.user.id,
        req.params.tournamentId,
        req.body || {}
      );
      audit(req.user.id, "discovery_tournament_entry_added", req, {
        tournament_id: req.params.tournamentId,
        entry_id: entry.id,
        operator_id: entry.operator_id,
        prediction_hash: entry.prediction_hash,
      });
      res.status(201).json({ entry });
    } catch (err) {
      res.status(409).json({ error: message(err) });
    }
  });

  router.post("/tournaments/:tournamentId/freeze", checkCsrf, async (req, res) => {
    try {
      const tournament = await genome.freezeTournament(
        req.user.id,
        req.params.tournamentId,
        req.body?.expected_review_hash
      );
      audit(req.user.id, "discovery_tournament_frozen", req, {
        tournament_id: tournament.id,
        manifest_hash: tournament.manifest_hash,
      });
      res.json({ tournament });
    } catch (err) {
      res.status(/not found/i.test(message(err)) ? 404 : 409).json({ error: message(err) });
    }
  });

  router.post("/tournaments/:tournamentId/entries/:entryId/result", checkCsrf, async (req, res) => {
    try {
      const entry = await genome.recordTournamentResult(
        req.user.id,
        req.params.tournamentId,
        req.params.entryId,
        req.body || {}
      );
      audit(req.user.id, "discovery_tournament_result_recorded", req, {
        tournament_id: req.params.tournamentId,
        entry_id: entry.id,
        verdict: entry.verdict,
      });
      res.json({ entry });
    } catch (err) {
      res.status(/not found/i.test(message(err)) ? 404 : 409).json({ error: message(err) });
    }
  });

  return router;
}

module.exports = createDiscoveryGenomeRouter;
