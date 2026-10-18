defmodule ChalkSync.Chat.ReactionsPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Chat
  alias ChalkSync.Chat.Repository.Postgres, as: Repository
  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    fanout = start_supervised!({Collaboration, name: nil})
    {:ok, fixture: fixture, fanout: fanout}
  end

  test "two clients receive reactions, retries converge, history restores them, and deleting the message removes them",
       %{connection: connection, fixture: fixture, fanout: fanout} do
    [first, second] = fixture.identities
    parent = self()

    peer =
      spawn_link(fn ->
        {:ok, _welcome} =
          Chat.negotiate(
            second,
            %{extension: "collaboration_v2", after_sequence: nil, retained_floor_sequence: nil},
            self(),
            fanout: fanout
          )

        send(parent, :peer_ready)

        receive do
          {:collaboration_frame, frame} -> send(parent, {:peer_frame, frame})
        end
      end)

    peer_ref = Process.monitor(peer)
    assert_receive :peer_ready

    {:ok, %{message: message}} =
      Repository.append(first, %{
        client_message_id: "chat-reaction-message-0001",
        text: "Hello",
        attachment_ids: []
      })

    input = %{
      request_id: "chat-reaction-request-0001",
      message_id: message.message_id,
      emoji: "👏",
      on: true
    }

    assert {:ok, %{"outcome" => "accepted", "state" => state}} =
             Chat.react(first, input, fanout: fanout)

    assert GeneratedV1.valid_server_frame?(state)
    assert_receive {:peer_frame, ^state}
    assert state["reactions"] == [%{"emoji" => "👏", "participant_ids" => [first.participant_id]}]
    assert {:ok, %{"state" => ^state}} = Chat.react(first, input, fanout: fanout)

    assert {:ok, %{"messages" => [restored]}} =
             Chat.read_chat_page(second, %{
               request_id: "chat-history-request-0001",
               direction: "older",
               cursor_sequence: nil,
               limit: 100
             })

    assert restored["reactions"] == state["reactions"]
    assert restored["reaction_revision"] == state["revision"]
    assert GeneratedV1.valid_server_frame?(restored)

    assert {:ok, %{"state" => %{"reactions" => []} = cleared}} =
             Chat.react(first, %{input | on: false}, fanout: fanout)

    assert {:ok, %{"state" => ^cleared}} = Chat.react(first, %{input | on: false}, fanout: fanout)
    assert {:ok, _result} = Chat.react(first, input, fanout: fanout)

    Postgrex.query!(
      connection,
      "delete from sync_chat_messages where tenant_id = $1 and space_id = $2 and message_id = $3",
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(fixture.episode.space_id),
        UUID.dump!(message.message_id)
      ]
    )

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_chat_message_reactions where message_id = $1",
               [UUID.dump!(message.message_id)]
             ).rows

    assert_receive {:DOWN, ^peer_ref, :process, ^peer, :normal}
  end

  test "keeps the v1 wire shape and suppresses new frames for older clients", %{fixture: fixture} do
    [first, second] = fixture.identities

    {:ok, %{message: message}} =
      Repository.append(first, %{
        client_message_id: "chat-compatibility-message-0001",
        text: "Hello",
        attachment_ids: []
      })

    {:ok, page} =
      Chat.read_chat_page(
        second,
        %{
          request_id: "chat-compatibility-request-0001",
          direction: "older",
          cursor_sequence: nil,
          limit: 100
        },
        version: 1
      )

    [wire] = page["messages"]
    refute Map.has_key?(wire, "reactions")
    refute Map.has_key?(wire, "reaction_revision")
    state = %{collaboration_version: 1}

    assert {:ok, ^state} =
             ChalkSync.Transport.SocketV1.handle_info(
               {:collaboration_frame,
                %{"type" => "chat_reactions", "message_id" => message.message_id}},
               state
             )

    assert {:ok, ^state} =
             ChalkSync.Transport.SocketV1.handle_info(
               {:collaboration_frame, %{"type" => "reaction", "reaction" => "👏"}},
               state
             )

    assert {:ok, %{"outcome" => "rejected", "error_code" => "invalid_payload"}} =
             ChalkSync.Reactions.send(
               first,
               %{operation_id: "legacy-reaction-operation", reaction: "👏"},
               version: 1
             )
  end

  test "bounds memberships but still allows a full message's reactions to be cleared", %{
    connection: connection,
    fixture: fixture,
    fanout: fanout
  } do
    [first, second] = fixture.identities

    {:ok, %{message: message}} =
      Repository.append(first, %{
        client_message_id: "chat-capacity-message-0001",
        text: "Hello",
        attachment_ids: []
      })

    params = [
      UUID.dump!(fixture.episode.tenant_id),
      UUID.dump!(fixture.episode.space_id),
      UUID.dump!(message.message_id),
      UUID.dump!(first.participant_id)
    ]

    Postgrex.query!(
      connection,
      "insert into sync_chat_message_reactions (tenant_id, space_id, message_id, participant_id, emoji) select $1, $2, $3, case when n = 1 then $4::uuid else gen_random_uuid() end, '👍' from generate_series(1,128) n",
      params
    )

    input = %{
      request_id: "chat-capacity-request-0001",
      message_id: message.message_id,
      emoji: "👍",
      on: true
    }

    assert {:ok, %{"outcome" => "rejected", "error_code" => "overloaded"}} =
             Chat.react(second, input, fanout: fanout)

    assert {:ok, %{"outcome" => "accepted", "state" => snapshot}} =
             Chat.react(first, %{input | on: false}, fanout: fanout)

    assert GeneratedV1.valid_server_frame?(snapshot)
    assert Enum.sum(Enum.map(snapshot["reactions"], &length(&1["participant_ids"]))) == 127
    assert {:ok, %{"outcome" => "accepted"}} = Chat.react(second, input, fanout: fanout)
  end

  test "rejects emoji outside the fixed set and participants without sendChat", %{
    connection: connection,
    fixture: fixture,
    fanout: fanout
  } do
    [first, second] = fixture.identities

    {:ok, %{message: message}} =
      Repository.append(first, %{
        client_message_id: "chat-reaction-message-0002",
        text: "Hello",
        attachment_ids: []
      })

    input = %{
      request_id: "chat-reaction-request-0002",
      message_id: message.message_id,
      emoji: "not-an-emoji",
      on: true
    }

    assert {:ok, %{"outcome" => "rejected", "error_code" => "invalid_payload"}} =
             Chat.react(first, input, fanout: fanout)

    Postgrex.query!(
      connection,
      "update participants set role = 'observer', capabilities = $1 where id = $2",
      [["subscribe", "sendReaction"], UUID.dump!(second.participant_id)]
    )

    observer = second

    assert {:ok, %{"outcome" => "rejected", "error_code" => "capability_denied"}} =
             Chat.react(observer, %{input | emoji: "👍"}, fanout: fanout)

    for emoji <- GeneratedV1.metadata()["collaboration"]["reactions"] do
      assert {:ok, %{"outcome" => "accepted"}} =
               Chat.react(first, %{input | emoji: emoji}, fanout: fanout)
    end
  end
end
