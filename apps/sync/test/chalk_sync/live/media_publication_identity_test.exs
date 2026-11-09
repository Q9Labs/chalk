defmodule ChalkSync.Live.MediaPublicationIdentityTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Live.Projection
  alias ChalkSync.ProviderBridge.Codec

  @participant_id "11111111-1111-4111-8111-111111111111"

  test "a paused publication retains its identity through observation and projection" do
    publication = %{
      "participant_id" => @participant_id,
      "source" => "microphone",
      "enabled" => false,
      "publication_id" => "cloudflare-track-id"
    }

    observation = %{
      "observations" => [%{"incarnation" => 1, "sequence" => 2, "publications" => [publication]}],
      "has_more" => false,
      "next_cursor" => nil
    }

    assert {:ok, %{publications: [%{enabled: false, publication_id: "cloudflare-track-id"}]}} =
             Codec.decode_observation_response(observation, 10, 10)

    assert {:ok, _projection, frame} = Projection.replace(:media, [publication])
    assert GeneratedV1.valid_server_frame?(frame)

    assert {:error, :malformed_response} =
             Codec.decode_observation_response(
               put_in(
                 observation,
                 ["observations", Access.at(0), "publications", Access.at(0)],
                 %{
                   publication
                   | "enabled" => true,
                     "publication_id" => nil
                 }
               ),
               10,
               10
             )
  end
end
