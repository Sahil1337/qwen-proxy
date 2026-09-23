/**
 * Shared bits for the cloud examples: one client and a tiny print helper.
 *
 * These are the counterpart to `apps/proxy/examples/`, which target the proxy
 * and its extensions. These target a hosted OpenAI-compatible provider with an
 * API key, using only what such a provider actually implements — no `route()`,
 * `inspect()`, `health()`, `mode` or `debug`.
 *
 * Read from `scripts/.env` (see `../.env.example`) or the real environment.
 * Bun loads `.env` from the working directory only, so it must be `scripts/.env`
 * — a `.env` at the repository root is not picked up. Same variable names as
 * `apps/api/.env`, separate file:
 *
 *   PROXY_BASE_URL   the host minus the `/v1` the client appends
 *   PROXY_API_KEY    the provider's key
 *   PROXY_MODEL      a model name that provider recognises
 */
import { QwenProxyClient } from "qwen-proxy/client";

export const baseUrl = process.env.PROXY_BASE_URL ?? "https://api.groq.com/openai";
export const model = process.env.PROXY_MODEL ?? "llama-3.3-70b-versatile";

if (!process.env.PROXY_API_KEY) {
  console.error("PROXY_API_KEY is not set. These examples call a hosted provider and need a key.");
  console.error("Copy scripts/.env.example to scripts/.env, or pass the variables inline.");
  process.exit(1);
}

export const qwen = new QwenProxyClient({
  baseUrl,
  apiKey: process.env.PROXY_API_KEY,
  model,
  timeoutMs: 60_000,
});

export const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(14)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

/** Every example opens with this, so the output says which host produced it. */
export const header = (title: string) => console.log(`${title}\n${baseUrl}  ${model}\n`);

/**
 * One meeting in the transcript grammar `@meetai/core` parses:
 * `Speaker [HH:MM YYYY-MM-DD]: text`, one utterance per line. The examples
 * all work from this same meeting so their outputs are comparable.
 */
export const TRANSCRIPT = `Sahil [15:02 2026-09-07]: Alright, I think we should actually settle the architecture today because we're starting to have different versions of it in everyone's head. I was looking at the doc last night and half the things are still marked "TBD". Let's at least decide what we're building for the prototype and what we're deliberately leaving for later.
Yash [15:03 2026-09-07]: Yeah, especially the retrieval part. I was going through the transcript examples and I'm still not convinced that just chopping the transcript into chunks and throwing those into a vector database is going to work. It feels like we're going to retrieve a lot of conversation and not the actual information we're looking for.
Prakrati [15:03 2026-09-07]: Wait, before that, are we doing transcription ourselves or not? I remember someone saying we might use Whisper, and then yesterday I saw something completely different in the document.
Sahil [15:04 2026-09-07]: No, we're not building transcription for this. That's way too much scope for the prototype. We'll assume the input is already speaker-labelled and timestamped, basically speaker name, timestamp, and the transcript text.
Tejasva [15:04 2026-09-07]: So if we get something like "Yash, 3:20 PM, blah blah", that's already our input? We don't have to figure out who's speaking from the audio?
Sahil [15:04 2026-09-07]: Exactly. Diarization and transcription are out of scope. Everything after that is our problem.
Rishita [15:05 2026-09-07]: Okay, that's actually nice because I was imagining we'd have to deal with audio files too.
Yash [15:05 2026-09-07]: Coming back to embeddings, the main problem with chunks is that a lot of the useful information in a meeting isn't really a nice paragraph. Someone says, "yeah, I'll take that, and we can probably finish it by Friday," and then "that" refers to something from two minutes earlier. If we store the raw chunk, the embedding doesn't really have a clean representation of the thing we care about.
Tejasva [15:06 2026-09-07]: So you want the LLM to turn that into an actual claim before we embed it?
Yash [15:06 2026-09-07]: Yeah. Something like "Yash is responsible for the claim schema" or "the claim schema is due Friday". Basically one fact per proposition, with all the context filled in so it makes sense by itself.
Prakrati [15:07 2026-09-07]: But aren't we then trusting the four-billion model to rewrite everything correctly? Because if it changes one word, the vector database is now storing something that nobody actually said.
Yash [15:07 2026-09-07]: That's the annoying part, yeah. Extraction is probably the biggest failure point in the whole pipeline.
Sahil [15:08 2026-09-07]: Which is why the proposition shouldn't replace the transcript. Every proposition should have a reference back to the exact meeting and source lines. If the generated claim says something weird, the UI should be able to show the original sentence underneath it.
Rishita [15:08 2026-09-07]: Yeah, I'd actually make that visible. Like answer first, then "source" and expand the transcript lines. Otherwise during the demo someone is definitely going to ask where the answer came from.
Tejasva [15:09 2026-09-07]: What about the three indexes we put in the design? Claim, transcript, and meeting? Are we still doing all three?
Sahil [15:09 2026-09-07]: I don't think so. The meeting-level one is useful for questions like "what was that planning meeting about?", but that's not something I want to spend time implementing right now. The claim index is the important one for the prototype.
Yash [15:10 2026-09-07]: Agreed. We can always add the meeting-level stuff later if we actually need it.
Tejasva [15:10 2026-09-07]: And the transcript index?
Yash [15:10 2026-09-07]: I don't think we need to embed the transcript separately. The proposition can just store the meeting ID and line range, and then we fetch the original transcript from Postgres when we need evidence.
Tejasva [15:11 2026-09-07]: Oh, right. So we're retrieving the proposition with similarity, but retrieving the evidence with a normal database lookup.
Sahil [15:11 2026-09-07]: Yeah, exactly. That's the distinction I wanted in the design. So for the prototype: claim index only, transcript through pointers, meeting index deferred.
Prakrati [15:11 2026-09-07]: Deferred until when?
Sahil [15:12 2026-09-07]: Probably next semester. I don't want to promise an exact date because honestly we have enough things to finish already.
Yash [15:12 2026-09-07]: That's fair.
Sahil [15:12 2026-09-07]: Okay, embeddings. Tejasva, what did you find?
Tejasva [15:13 2026-09-07]: I checked bge-small, gte-base, and nomic. bge-small is 384 dimensions and it's obviously easier to run, while the others are around 768. The bigger models do a little better on the retrieval benchmarks I found, but I'm not sure the difference is worth making the pipeline slower.
Yash [15:13 2026-09-07]: Why don't we just use the OpenAI embedding endpoint? It's cheap enough, and we'd probably get better quality without worrying about running another model.
Sahil [15:14 2026-09-07]: Because then the project isn't really self-hosted anymore. The whole point of putting the LLM on the Nitro was that the demo should work without depending on somebody's API key or an internet service being up.
Yash [15:14 2026-09-07]: I mean, it's a college project. I don't think anyone's going to audit our architecture that hard.
Sahil [15:14 2026-09-07]: Maybe not, but the guide is absolutely going to ask where everything is running. And I'd rather not find out on review day that the API key expired or someone's card has a problem.
Rishita [15:15 2026-09-07]: Also we'd have two external things that can randomly fail instead of one. I'd rather keep embeddings local too.
Yash [15:15 2026-09-07]: Fine, local. But can we keep the embedding provider behind an interface? If bge-small turns out to be bad, I don't want to rewrite the whole retrieval code just to switch models.
Tejasva [15:15 2026-09-07]: Yeah, that part is worth doing anyway.
Sahil [15:16 2026-09-07]: One limitation though: don't plan on running the embedding model on the Nitro. It's a four-gig 3050 and the LLM already takes most of that memory. For now embeddings can run on my Mac, and we'll do the same for the demo.
Yash [15:16 2026-09-07]: That's not exactly a deployment I'd put on LinkedIn.
Sahil [15:16 2026-09-07]: I know. It's just the prototype setup.
Prakrati [15:17 2026-09-07]: How much space do these vectors actually take? I genuinely have no idea whether ten thousand claims is huge or basically nothing.
Tejasva [15:17 2026-09-07]: It's basically nothing at our scale. A 768-dimensional vector with four bytes per value is about three KB, so even ten thousand claims is only around thirty MB. Storage isn't going to be our problem.
Prakrati [15:17 2026-09-07]: Okay, that's much smaller than I expected.
Sahil [15:18 2026-09-07]: Extraction time is the bigger issue. On the Nitro we're getting roughly twenty tokens per second with tools enabled, so a one-hour meeting can take around fifteen minutes of GPU time.
Rishita [15:18 2026-09-07]: Wait, fifteen minutes for one meeting? Then we definitely can't make the upload request sit there until everything finishes.
Sahil [15:18 2026-09-07]: Yeah, it has to be a background job. The frontend should show something like processing, completed, failed, whatever.
Rishita [15:19 2026-09-07]: Then I'll need a job status endpoint. I can work with that, I just need the API to tell me what state it's in.
Sahil [15:19 2026-09-07]: Put it in the API contract. I'll handle that part.
Yash [15:19 2026-09-07]: What did we settle on for chunk size? I remember sixty to ninety seconds being in the doc.
Sahil [15:20 2026-09-07]: Let's start with sixty seconds. We can change it later if the extraction quality is bad, but I don't want another range to worry about for the prototype.
Prakrati [15:20 2026-09-07]: And we're giving the model some context outside the chunk, right? Because otherwise it's going to see "he'll do it tomorrow" and have no idea who "he" is.
Yash [15:20 2026-09-07]: Yeah, a small context header. Meeting name, participants, and a little bit about what was being discussed before the chunk. It's basically there to give the extraction model enough context to resolve those references.
Tejasva [15:21 2026-09-07]: Do we put that header into the embedding too?
Yash [15:21 2026-09-07]: No, only send it to the extraction model. The actual proposition is what we embed.
Tejasva [15:21 2026-09-07]: Because otherwise every proposition from the same meeting gets the same header and the vectors start becoming similar for the wrong reason.
Yash [15:22 2026-09-07]: Exactly. We want the embedding to represent the claim, not the meeting metadata.
Sahil [15:22 2026-09-07]: Okay, so sixty-second chunks, context header for extraction only, and proposition text goes into the index.
Tejasva [15:23 2026-09-07]: Retrieval is the other thing I'm worried about. I don't think pure vector search is enough. If someone asks "who owns the payment API?" or "what's due Friday?", that's not really a semantic question. We already have those fields in the database.
Yash [15:23 2026-09-07]: So SQL for structured questions and vector search for the open-ended ones?
Tejasva [15:23 2026-09-07]: Yeah. Something like "why did we choose Postgres?" should go semantic, but "who owns database work?" should be able to hit the claims table directly.
Rishita [15:24 2026-09-07]: And how do we know which one the user asked?
Tejasva [15:24 2026-09-07]: Small LLM classification call. It just decides whether the query is structured or semantic.
Yash [15:24 2026-09-07]: For the semantic side I'd still use hybrid search. BM25 plus vector search, then combine the rankings.
Tejasva [15:25 2026-09-07]: What about a reranker after that?
Yash [15:25 2026-09-07]: I'd like one eventually, but I don't think we should build it immediately.
Tejasva [15:25 2026-09-07]: Same. We don't even have an evaluation set yet, so we wouldn't know whether the reranker actually improved anything or we're just adding another model because it sounds good.
Sahil [15:26 2026-09-07]: Yeah, let's do hybrid first and leave the reranker explicitly deferred. Once we have a golden evaluation set, we can compare it properly instead of guessing.
Yash [15:26 2026-09-07]: Works for me.
Sahil [15:26 2026-09-07]: Database?
Tejasva [15:27 2026-09-07]: Postgres with pgvector. I'd rather keep the claims and vectors in the same place.
Yash [15:27 2026-09-07]: Why not Qdrant? Or even Chroma? Chroma would take about five minutes to get running.
Tejasva [15:27 2026-09-07]: Because the claims aren't just vectors. We've got owner, meeting, timestamp, type, validity, all that stuff. If the vector database is separate, now every query has to somehow coordinate between two systems.
Yash [15:28 2026-09-07]: But Qdrant can store metadata.
Tejasva [15:28 2026-09-07]: Sure, but then we're maintaining two different data models. And imagine we write the claim to Postgres and the vector write fails. Now they're out of sync. I'd rather have one database and deal with one consistency problem.
Prakrati [15:28 2026-09-07]: Is pgvector actually fast enough though? I've only seen people use it for examples.
Tejasva [15:29 2026-09-07]: At our scale, yeah. We're talking a few thousand claims, maybe ten thousand eventually. That's nowhere near the kind of scale where I'd worry about it.
Sahil [15:29 2026-09-07]: Have you actually used pgvector before?
Tejasva [15:29 2026-09-07]: Not in production.
Yash [15:29 2026-09-07]: Excellent.
Tejasva [15:29 2026-09-07]: Shut up. I said it should be fine.
Sahil [15:30 2026-09-07]: That's enough for me. We'll use it, but let's write down that we've only validated it at prototype scale. If we ever scale this up, that's something we'll have to revisit.
Tejasva [15:30 2026-09-07]: Yeah, fine.
Sahil [15:30 2026-09-07]: Stack is basically React and Vite with TypeScript on the frontend, Node and Express on the backend, Postgres, and the LLM behind an OpenAI-compatible endpoint.
Rishita [15:31 2026-09-07]: Tailwind?
Prakrati [15:31 2026-09-07]: Please say yes.
Sahil [15:31 2026-09-07]: Yes, Tailwind.
Yash [15:31 2026-09-07]: Why are we doing Node though? Wouldn't Python make more sense since the embedding and ML stuff is Python anyway?
Tejasva [15:32 2026-09-07]: We're not actually training anything. The backend is mostly HTTP calls and SQL. TypeScript everywhere is probably simpler.
Yash [15:32 2026-09-07]: Except the embedding model.
Sahil [15:32 2026-09-07]: That's fine. We'll make the embedding part a small Python service with an HTTP endpoint. I'm not splitting the entire backend just because one component uses Python.
Yash [15:33 2026-09-07]: Yeah, that works.
Sahil [15:33 2026-09-07]: Okay, assignments. I'll take ingestion, transcript parsing, chunking, the queue, Nitro hosting, and deployment.
Yash [15:34 2026-09-07]: I'll take extraction then. Prompt, proposition schema, tool calling, and actually testing whether the model is producing useful claims.
Tejasva [15:34 2026-09-07]: I'll handle database and retrieval. Schema, pgvector, hybrid search, query routing, all of that.
Sahil [15:34 2026-09-07]: You need the claim schema first though.
Tejasva [15:35 2026-09-07]: Yeah, that's the annoying dependency. I can't really finalize the database table while the fields are still changing.
Yash [15:35 2026-09-07]: I'll send you the final field list by Friday. The prompt might still change after that, but the actual schema shape shouldn't.
Tejasva [15:35 2026-09-07]: That's enough.
Sahil [15:36 2026-09-07]: Prakrati, Rishita, you two are doing frontend?
Prakrati [15:36 2026-09-07]: I'll take upload and the meeting pages. So meeting list, transcript view, and the processing state. Basically everything around getting a meeting into the system and looking at it.
Rishita [15:37 2026-09-07]: Then I'll take the Q&A side and citations. I want the answer page to show which claims were used and then let you expand the actual transcript lines underneath.
Prakrati [15:37 2026-09-07]: We need the API before we can properly connect any of that though.
Sahil [15:37 2026-09-07]: I'll draft it early next week, but it depends on Yash freezing the schema.
Prakrati [15:38 2026-09-07]: We can just use some fake JSON until then. Otherwise we're going to spend three days waiting for the backend.
Sahil [15:38 2026-09-07]: Yeah, do that. Just don't call the model proxy directly from the frontend.
Rishita [15:38 2026-09-07]: Obviously. Everything through the backend.
Tejasva [15:39 2026-09-07]: One thing we're missing though: evaluation. We keep saying "this should improve retrieval" and "the reranker should help", but right now none of us has an actual test set to prove any of it.
Yash [15:39 2026-09-07]: Yeah, that's true. Even extraction quality is basically just us looking at outputs and saying "looks okay".
Sahil [15:40 2026-09-07]: Let's put the evaluation set on Thursday's agenda and decide who owns it then. I don't want to assign another thing right now when everyone's already taking a chunk.
Tejasva [15:40 2026-09-07]: Fine, but it has to happen before we decide whether the reranker stays deferred. Otherwise we're just guessing.
Sahil [15:40 2026-09-07]: Agreed.
Sahil [15:41 2026-09-07]: Last thing, the internal review is sometime in late October. We don't have the exact date yet.
Prakrati [15:41 2026-09-07]: Are they expecting change detection for that?
Sahil [15:41 2026-09-07]: No, that's next semester. The review is basically supposed to show the end-to-end flow: transcript goes in, propositions come out, someone asks a question, and we return an answer with the source line.
Rishita [15:42 2026-09-07]: Okay, that's manageable.
Sahil [15:42 2026-09-07]: I'll ask for the exact review date this week so we can plan backwards from it.
Yash [15:42 2026-09-07]: And I'll send the schema fields by Friday.
Tejasva [15:42 2026-09-07]: Which means I can start the database after Friday.
Prakrati [15:43 2026-09-07]: And we'll start with fake API data.
Sahil [15:43 2026-09-07]: Yeah. I think that's everything.
Rishita [15:43 2026-09-07]: Thursday same time?
Sahil [15:43 2026-09-07]: Yeah, same time Thursday. Let's actually have the eval discussion this time.
Yash [15:43 2026-09-07]: No promises.
Prakrati [15:43 2026-09-07]: Bye.
Sahil [15:43 2026-09-07]: Bye.`;
