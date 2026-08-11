"use strict";

const operatorProposals = require("./operatorProposals");
const programmeState = require("./programmeState");
const reviewTrace = require("./reviewTrace");

async function compileAndSaveProgrammeState(userId, graphId) {
  const [operators, reviews, traceEvents, questions] = await Promise.all([
    operatorProposals.listProposals(userId, graphId),
    reviewTrace.listReviewItems(userId, graphId),
    reviewTrace.listTraceEvents(userId, graphId, 200),
    reviewTrace.listQuestions(userId, graphId),
  ]);
  const snapshot = programmeState.compileProgrammeState({
    graphId,
    operators: reviewTrace.attachOperatorReviews(operators, reviews),
    reviews,
    traceEvents,
    questions,
  });
  return programmeState.saveProgrammeStateSnapshot(userId, graphId, snapshot);
}

async function generateAndSaveQuestions(userId, graphId) {
  const snapshot = await compileAndSaveProgrammeState(userId, graphId);
  const proposed = programmeState.generateQuestionsFromSnapshot(snapshot).map(question => ({
    ...question,
    programme_state_snapshot_id: snapshot.id,
    provenance: { ...(question.provenance || {}), source_snapshot_id: snapshot.id },
  }));
  const questions = await reviewTrace.saveGeneratedQuestions(userId, graphId, proposed);
  await reviewTrace.createTraceEvent(userId, graphId, {
    event_type: "next_question_candidate",
    title: `Generated ${questions.length} programme-state question candidate${questions.length === 1 ? "" : "s"}`,
    description: "Question generation used the compiled programme state. Cards remain review-needed and do not mutate claims.",
    source_type: "programme_state_snapshot",
    source_ref_id: snapshot.id,
    admissibility_effect: questions.length ? "permits_question" : "none",
  });
  return { snapshot, questions };
}

module.exports = { compileAndSaveProgrammeState, generateAndSaveQuestions };
