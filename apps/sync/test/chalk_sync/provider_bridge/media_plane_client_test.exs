defmodule ChalkSync.ProviderBridge.MediaPlaneClientTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.Stateholder.EpisodeKey

  @tenant_id "33333333-3333-4333-8333-333333333333"
  @episode_id "44444444-4444-4444-8444-444444444444"
  @space_id "55555555-5555-4555-8555-555555555555"
  @participant_id "66666666-6666-4666-8666-666666666666"

  test "reads the current disabled camera after history exceeds the response byte bound" do
    history = Enum.map(1..110, &observation/1)
    latest = List.last(history)
    historical_body = JSON.encode!(page(history))
    assert byte_size(historical_body) > 65_536
    owner = self()

    transport = fn :get, url, _headers, _body, _options ->
      query = url |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()
      send(owner, {:query, query})
      body = if query["latest"] == "true", do: JSON.encode!(page([latest])), else: historical_body
      {:ok, 200, [], body}
    end

    client = Client.new!(base_url: "http://localhost:4000", transport: transport)
    episode = %EpisodeKey{tenant_id: @tenant_id, episode_id: @episode_id, space_id: @space_id}

    assert {:ok, %{incarnation: 1, sequence: 110, publications: publications}} =
             Client.observe_episode_publications(client, episode)

    assert Enum.all?(publications, &(!&1.enabled))

    assert_receive {:query,
                    %{"latest" => "true", "tenant_id" => @tenant_id, "episode_id" => @episode_id}}

    refute_receive {:query, _}
  end

  test "explicit cursor reads retain the paginated history contract" do
    owner = self()

    transport = fn :get, url, _headers, _body, _options ->
      send(owner, {:query, url |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()})
      {:ok, 200, [], JSON.encode!(page([observation(110)]))}
    end

    client = Client.new!(base_url: "http://localhost:4000", transport: transport)
    episode = %EpisodeKey{tenant_id: @tenant_id, episode_id: @episode_id, space_id: @space_id}

    assert {:ok, %{sequence: 110}} =
             Client.observe_episode_publications(client, episode,
               after_incarnation: 1,
               after_sequence: 109
             )

    assert_receive {:query, query}
    assert query["after_incarnation"] == "1"
    assert query["after_sequence"] == "109"
    refute Map.has_key?(query, "latest")
  end

  defp observation(sequence) do
    publications =
      Enum.map(["microphone", "camera", "screen"], fn source ->
        enabled = sequence < 110

        %{
          "participant_id" => @participant_id,
          "source" => source,
          "enabled" => enabled,
          "publication_id" => if(enabled, do: String.duplicate("p", 250), else: nil)
        }
      end)

    %{"incarnation" => 1, "sequence" => sequence, "publications" => publications}
  end

  defp page(observations),
    do: %{"observations" => observations, "has_more" => false, "next_cursor" => nil}
end
