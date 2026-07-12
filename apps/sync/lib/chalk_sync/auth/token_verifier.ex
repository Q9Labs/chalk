defmodule ChalkSync.Auth.TokenVerifier do
  @moduledoc """
  Port for participant-token verification.

  Production uses API-issued Ed25519 tokens and an environment-scoped,
  overlap-rotatable public keyset. Chalk never accepts client-asserted identity
  without a valid signature.
  """

  alias ChalkSync.Auth.Claims

  @callback verify(token :: String.t()) :: {:ok, Claims.t()} | {:error, atom()}

  @spec verify(String.t()) :: {:ok, Claims.t()} | {:error, atom()}
  def verify(token), do: impl().verify(token)

  defp impl, do: Application.fetch_env!(:chalk_sync, :token_verifier)
end
