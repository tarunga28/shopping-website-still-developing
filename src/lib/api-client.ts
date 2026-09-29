"use client";

/**
 * Tiny typed fetch wrapper for browser→API calls.
 * Throws ApiClientError carrying the server-provided safe message.
 */

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "INTERNAL_ERROR") {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      headers: { "Content-Type": "application/json", ...init?.headers },
      ...init,
    });
  } catch {
    throw new ApiClientError("Network issue — please check your connection and retry.", 0, "NETWORK");
  }

  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // Non-JSON response (e.g. upstream HTML error) — fall through to status handling.
  }

  if (!response.ok || !envelope?.ok) {
    throw new ApiClientError(
      envelope?.error?.message ?? "Something went wrong. Please try again.",
      response.status,
      envelope?.error?.code,
    );
  }

  return envelope.data as T;
}

export function apiPost<T, Body = unknown>(url: string, body: Body): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body) });
}
