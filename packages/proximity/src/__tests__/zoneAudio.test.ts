import { describe, it, expect } from "vitest";
import { effectiveAudio, type ZoneRef } from "../zoneAudio";
import type { ProximityState } from "../proximity";

const RAW_FAR: ProximityState = { audioSubscribed: false, audioGain: 0, videoSubscribed: false };
const RAW_NEAR: ProximityState = { audioSubscribed: true, audioGain: 0.5, videoSubscribed: false };
const FULL: ProximityState = { audioSubscribed: true, audioGain: 1, videoSubscribed: true };
const MUTED: ProximityState = { audioSubscribed: false, audioGain: 0, videoSubscribed: false };

const meetingA: ZoneRef = { id: "meet-a", kind: "meeting" };
const meetingB: ZoneRef = { id: "meet-b", kind: "meeting" };
const cabin1: ZoneRef = { id: "cabin-1", kind: "cabin" };
const stage: ZoneRef = { id: "stage-1", kind: "stage" };
const audienceOfStage1: ZoneRef = { id: "aud-1", kind: "audience", stageId: "stage-1" };
const otherStage: ZoneRef = { id: "stage-2", kind: "stage" };
const audienceOfOtherStage: ZoneRef = { id: "aud-2", kind: "audience", stageId: "stage-2" };
const openLounge: ZoneRef = { id: "lounge", kind: "open" };
const focus: ZoneRef = { id: "focus-1", kind: "focus" };

describe("effectiveAudio", () => {
  it("same meeting room: full gain regardless of raw distance", () => {
    expect(effectiveAudio(RAW_FAR, meetingA, meetingA)).toEqual(FULL);
  });

  it("meeting room listener, speaker elsewhere (no zone): muted", () => {
    expect(effectiveAudio(RAW_NEAR, meetingA, null)).toEqual(MUTED);
  });

  it("listener elsewhere (no zone), speaker in a meeting room: muted", () => {
    expect(effectiveAudio(RAW_NEAR, null, meetingA)).toEqual(MUTED);
  });

  it("two different meeting rooms: muted, never leaks across rooms", () => {
    expect(effectiveAudio(RAW_NEAR, meetingA, meetingB)).toEqual(MUTED);
  });

  it("same cabin: full gain", () => {
    expect(effectiveAudio(RAW_FAR, cabin1, cabin1)).toEqual(FULL);
  });

  it("cabin vs meeting room (both private, different zones): muted", () => {
    expect(effectiveAudio(RAW_NEAR, cabin1, meetingA)).toEqual(MUTED);
  });

  it("audience hears its own stage at full gain regardless of distance", () => {
    expect(effectiveAudio(RAW_FAR, audienceOfStage1, stage)).toEqual(FULL);
  });

  it("audience does NOT hear a different stage at full gain", () => {
    expect(effectiveAudio(RAW_FAR, audienceOfStage1, otherStage)).toEqual(RAW_FAR);
  });

  it("the stage (presenter) hears an audience member via raw proximity, not full gain", () => {
    expect(effectiveAudio(RAW_NEAR, stage, audienceOfStage1)).toEqual(RAW_NEAR);
  });

  it("two audience members of the same hall hear each other via raw proximity", () => {
    expect(effectiveAudio(RAW_NEAR, audienceOfStage1, audienceOfStage1)).toEqual(RAW_NEAR);
  });

  it("audience members of two different halls: raw proximity (not specially muted or boosted)", () => {
    expect(effectiveAudio(RAW_NEAR, audienceOfStage1, audienceOfOtherStage)).toEqual(RAW_NEAR);
  });

  it("same open zone: full gain regardless of raw distance", () => {
    expect(effectiveAudio(RAW_FAR, openLounge, openLounge)).toEqual(FULL);
  });

  it("open zone vs outside: raw proximity (open areas aren't private)", () => {
    expect(effectiveAudio(RAW_NEAR, openLounge, null)).toEqual(RAW_NEAR);
  });

  it("a focus-zone listener is muted no matter who's speaking", () => {
    expect(effectiveAudio(RAW_NEAR, focus, null)).toEqual(MUTED);
    expect(effectiveAudio(RAW_NEAR, focus, openLounge)).toEqual(MUTED);
  });

  it("a focus-zone SPEAKER does not mute their listener (only affects the focus occupant's own hearing)", () => {
    expect(effectiveAudio(RAW_NEAR, openLounge, focus)).toEqual(RAW_NEAR);
    expect(effectiveAudio(RAW_NEAR, null, focus)).toEqual(RAW_NEAR);
  });

  it("both outside any zone: raw proximity, unchanged", () => {
    expect(effectiveAudio(RAW_NEAR, null, null)).toEqual(RAW_NEAR);
    expect(effectiveAudio(RAW_FAR, null, null)).toEqual(RAW_FAR);
  });
});
