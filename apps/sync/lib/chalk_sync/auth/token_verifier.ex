defmodule ChalkSync.Auth.TokenVerifier do
  @moduledoc """
  Port for participant-token verification.

  Production adapter (next): verify tenant-signed tokens against per-tenant,
  rotatable public keys (north-star constraint 12 — Chalk never accepts
  client-asserted identity without a valid signature). The key registry comes
  from the control-plane API.
  """

  alias ChalkSync.Auth.Claims

  @callback verify(token :: String.t()) :: {:ok, Claims.t()} | {:error, atom()}

  @spec verify(String.t()) :: {:ok, Claims.t()} | {:error, atom()}
  def verify(token), do: impl().verify(token)

  defp impl, do: Application.fetch_env!(:chalk_sync, :token_verifier)
end
