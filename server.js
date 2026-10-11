/* Запуск эфира */

app.post("/api/streams/start", requireHost, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 150) || "Прямой эфир";
    const roomName = cleanText(req.body?.roomName, 100);

    if (!validRoomName(roomName)) {
      return res.status(400).json({
        error: "Неверное имя комнаты"
      });
    }

    await cleanupOldStreams();

    // Проверяем, не идёт ли уже другой эфир.
    const { data: existingLive, error: checkError } = await supabase
      .from("live_streams")
      .select("id, room_name")
      .eq("status", "live")
      .limit(1)
      .maybeSingle();

    if (checkError) {
      console.error("Ошибка проверки эфира:", checkError);
      return res.status(500).json({
        error: "Не удалось проверить активные эфиры"
      });
    }

    if (existingLive) {
      return res.status(409).json({
        error: "Уже есть активный эфир",
        roomName: existingLive.room_name
      });
    }

    // Повторно используем запись комнаты, если она уже существует.
    const { data, error } = await supabase
      .from("live_streams")
      .upsert(
        {
          title,
          room_name: roomName,
          status: "live",
          started_at: new Date().toISOString(),
          ended_at: null
        },
        {
          onConflict: "room_name"
        }
      )
      .select()
      .single();

    if (error) {
      console.error("Не удалось создать эфир:", error);

      return res.status(500).json({
        error: "Не удалось создать эфир",
        details: error.message
      });
    }

    hostActivity.set(roomName, Date.now());

    return res.json({
      success: true,
      stream: data,
      roomName
    });
  } catch (error) {
    console.error("Не удалось запустить эфир:", error);

    return res.status(500).json({
      error: "Не удалось запустить эфир",
      details: error.message
    });
  }
});
