#!/usr/bin/env python3
"""
ユドナリウムリコリス - ミュージックライブラリ管理ツール
VPSの /opt/udonarium-lycoris/audio-library/ をGUIで管理する

必要パッケージ: pip install paramiko mutagen
"""

import os
import sys
import json
import threading
import tempfile
import shutil
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

try:
    import paramiko
except ImportError:
    print("paramikoが必要です: pip install paramiko")
    sys.exit(1)

try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None

# ===== 設定 =====
VPS_HOST = "160.251.182.194"
VPS_USER = "root"
SSH_KEY = os.path.expanduser(
    "~/.openclaw/workspace/projects/udonarium-lycoris/VPSサーバー設定/key-2026-05-23-15-23.pem"
)
REMOTE_BASE = "/opt/udonarium-lycoris/audio-library"
API_CACHE_MINUTES = 5  # VPS側のAPIキャッシュ時間（参考）


class VPSConnection:
    """VPSへのSSH接続を管理"""

    def __init__(self):
        self.ssh = None
        self.sftp = None

    def connect(self):
        self.ssh = paramiko.SSHClient()
        self.ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.ssh.connect(
            VPS_HOST,
            username=VPS_USER,
            key_filename=SSH_KEY,
            timeout=15,
        )
        self.sftp = self.ssh.open_sftp()
        return True

    def disconnect(self):
        if self.sftp:
            self.sftp.close()
            self.sftp = None
        if self.ssh:
            self.ssh.close()
            self.ssh = None

    def is_connected(self):
        return self.ssh is not None and self.sftp is not None

    def list_categories(self):
        """カテゴリ（サブディレクトリ）一覧を取得"""
        if not self.sftp:
            return []
        try:
            entries = self.sftp.listdir_attr(REMOTE_BASE)
            return [e.filename for e in entries if e.st_mode and (e.st_mode & 0o040000)]
        except IOError:
            # ベースディレクトリが無ければ作る
            self.run_command(f"mkdir -p {REMOTE_BASE}")
            return []

    def list_files(self, category):
        """指定カテゴリ内のファイル一覧を取得"""
        remote_dir = f"{REMOTE_BASE}/{category}"
        try:
            entries = self.sftp.listdir_attr(remote_dir)
            result = []
            for e in entries:
                if e.filename == "meta.json":
                    continue
                if e.filename.endswith((".mp3", ".ogg", ".wav", ".m4a", ".flac")):
                    result.append(
                        {
                            "name": e.filename,
                            "size": e.st_size,
                            "path": f"{remote_dir}/{e.filename}",
                        }
                    )
            return result
        except IOError:
            return []

    def get_meta(self, category):
        """カテゴリのmeta.jsonを読み込む"""
        meta_path = f"{REMOTE_BASE}/{category}/meta.json"
        try:
            with self.sftp.open(meta_path, "r") as f:
                content = f.read().decode("utf-8")
                return json.loads(content)
        except (IOError, json.JSONDecodeError):
            return []

    def save_meta(self, category, meta_data):
        """カテゴリのmeta.jsonを書き込む"""
        meta_path = f"{REMOTE_BASE}/{category}/meta.json"
        content = json.dumps(meta_data, ensure_ascii=False, indent=2)
        with self.sftp.open(meta_path, "w") as f:
            f.write(content)

    def upload_file(self, local_path, category, remote_name=None, progress_cb=None):
        """ファイルをアップロード"""
        if remote_name is None:
            remote_name = os.path.basename(local_path)
        remote_dir = f"{REMOTE_BASE}/{category}"
        self.run_command(f"mkdir -p {remote_dir}")
        remote_path = f"{remote_dir}/{remote_name}"

        file_size = os.path.getsize(local_path)
        if progress_cb:
            progress_cb(0, file_size)

        self.sftp.put(local_path, remote_path)

        if progress_cb:
            progress_cb(file_size, file_size)

        return remote_path

    def delete_file(self, remote_path):
        """ファイルを削除"""
        self.sftp.remove(remote_path)

    def create_category(self, name):
        """カテゴリを作成"""
        self.run_command(f"mkdir -p {REMOTE_BASE}/{name}")

    def delete_category(self, name):
        """カテゴリを削除（中身ごと）"""
        if messagebox.askyesno(
            "確認", f"カテゴリ「{name}」を中身ごと削除しますか？\nこの操作は取り消せません。"
        ):
            self.run_command(f"rm -rf {REMOTE_BASE}/{name}")
            return True
        return False

    def rename_category(self, old_name, new_name):
        """カテゴリをリネーム"""
        self.run_command(f"mv {REMOTE_BASE}/{old_name} {REMOTE_BASE}/{new_name}")

    def download_file(self, remote_path, local_path):
        """ファイルをダウンロード"""
        self.sftp.get(remote_path, local_path)

    def run_command(self, cmd):
        """コマンドを実行"""
        stdin, stdout, stderr = self.ssh.exec_command(cmd)
        return stdout.read().decode(), stderr.read().decode()


def get_audio_duration(file_path):
    """mutagenで音声の再生時間を取得"""
    if not MutagenFile:
        return 0
    try:
        audio = MutagenFile(file_path)
        if audio and audio.info:
            return int(audio.info.length)
    except Exception:
        pass
    return 0


def format_size(bytes):
    if bytes < 1024:
        return f"{bytes} B"
    if bytes < 1024 * 1024:
        return f"{bytes / 1024:.1f} KB"
    return f"{bytes / 1024 / 1024:.1f} MB"


def format_duration(seconds):
    if not seconds or seconds <= 0:
        return "--:--"
    m = seconds // 60
    s = seconds % 60
    return f"{m}:{s:02d}"


class MusicLibraryManager(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("🎵 ユドナリウムリコリス - 音楽ライブラリ管理")
        self.geometry("900x650")
        self.minsize(700, 500)

        self.vps = VPSConnection()
        self.current_category = None
        self.tracks_data = []  # [{file, name, duration, size, path}]

        self._build_ui()
        self._connect_and_refresh()

    def _build_ui(self):
        # ===== メニューバー =====
        menubar = tk.Menu(self)
        self.config(menu=menubar)
        file_menu = tk.Menu(menubar, tearoff=False)
        menubar.add_cascade(label="ファイル", menu=file_menu)
        file_menu.add_command(label="再接続", command=self._connect_and_refresh)
        file_menu.add_separator()
        file_menu.add_command(label="終了", command=self.quit)

        # ===== メインレイアウト =====
        main_paned = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main_paned.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # --- 左ペイン: カテゴリ一覧 ---
        left_frame = ttk.LabelFrame(main_paned, text="カテゴリ", padding=4)
        main_paned.add(left_frame, weight=1)

        self.category_listbox = tk.Listbox(left_frame, font=("", 12), height=20)
        self.category_listbox.pack(fill=tk.BOTH, expand=True)
        self.category_listbox.bind("<<ListboxSelect>>", self._on_category_select)

        cat_btn_frame = ttk.Frame(left_frame)
        cat_btn_frame.pack(fill=tk.X, pady=(4, 0))
        ttk.Button(cat_btn_frame, text="追加", width=6, command=self._add_category).pack(
            side=tk.LEFT, padx=2
        )
        ttk.Button(cat_btn_frame, text="リネーム", width=6, command=self._rename_category).pack(
            side=tk.LEFT, padx=2
        )
        ttk.Button(cat_btn_frame, text="削除", width=6, command=self._delete_category).pack(
            side=tk.LEFT, padx=2
        )

        # --- 右ペイン: 曲リスト ---
        right_frame = ttk.Frame(main_paned)
        main_paned.add(right_frame, weight=3)

        # ツールバー
        toolbar = ttk.Frame(right_frame)
        toolbar.pack(fill=tk.X, pady=(0, 4))

        self.category_label = ttk.Label(toolbar, text="カテゴリ: （未選択）", font=("", 11, "bold"))
        self.category_label.pack(side=tk.LEFT)

        ttk.Button(toolbar, text="🎵 アップロード", command=self._upload_files).pack(
            side=tk.RIGHT, padx=2
        )
        ttk.Button(toolbar, text="🔄 更新", command=self._refresh_tracks).pack(
            side=tk.RIGHT, padx=2
        )

        # 曲リスト（Treeview）
        tree_frame = ttk.Frame(right_frame)
        tree_frame.pack(fill=tk.BOTH, expand=True)

        columns = ("name", "duration", "size", "meta_name")
        self.track_tree = ttk.Treeview(
            tree_frame, columns=columns, show="headings", selectmode="extended"
        )
        self.track_tree.heading("name", text="ファイル名")
        self.track_tree.heading("meta_name", text="表示名（meta.json）")
        self.track_tree.heading("duration", text="時間")
        self.track_tree.heading("size", text="サイズ")
        self.track_tree.column("name", width=250)
        self.track_tree.column("meta_name", width=200)
        self.track_tree.column("duration", width=60, anchor=tk.CENTER)
        self.track_tree.column("size", width=80, anchor=tk.E)

        scrollbar = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=self.track_tree.yview)
        self.track_tree.configure(yscrollcommand=scrollbar.set)

        self.track_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # 右クリックメニュー
        self.context_menu = tk.Menu(self, tearoff=False)
        self.context_menu.add_command(label="表示名を編集", command=self._edit_meta_name)
        self.context_menu.add_command(label="ダウンロード", command=self._download_file)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="削除", command=self._delete_tracks)
        self.track_tree.bind("<Button-3>", self._show_context_menu)

        # ダブルクリックで表示名編集
        self.track_tree.bind("<Double-1>", lambda e: self._edit_meta_name())

        # ステータスバー
        self.status_var = tk.StringVar(value="準備中...")
        ttk.Label(self, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W).pack(
            side=tk.BOTTOM, fill=tk.X
        )

        # ドラッグ&ドロップ対応（任意）
        self._setup_dnd()

    def _setup_dnd(self):
        """ドラッグ&ドロップ（TkinterDnDがあれば有効）"""
        try:
            import tkinterdnd2

            # TkinterDnDがインストールされていれば置き換え
            self.tk = tkinterdnd2.Tk()
            self.track_tree.drop_target_register("*/")
            self.track_tree.dnd_bind("<<Drop>>", self._on_drop)
        except ImportError:
            pass  # インストールされてなくてもOK

    def _on_drop(self, event):
        """ファイルドロップ時の処理"""
        if not self.current_category:
            messagebox.showinfo("情報", "先にカテゴリを選択してください。")
            return
        files = self.tk.splitlist(event.data)
        self._upload_files_async(files)

    def _set_status(self, text):
        self.status_var.set(text)
        self.update_idletasks()

    def _connect_and_refresh(self):
        """VPSに接続してカテゴリ一覧を更新"""
        self._set_status("VPSに接続中...")

        def task():
            try:
                if self.vps.is_connected():
                    self.vps.disconnect()
                self.vps.connect()
                self.after(0, self._refresh_categories)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"接続失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _refresh_categories(self):
        """カテゴリ一覧を更新"""
        self._set_status("カテゴリ一覧を取得中...")

        def task():
            try:
                categories = self.vps.list_categories()
                self.after(0, lambda: self._update_category_list(categories))
            except Exception as e:
                self.after(0, lambda: self._show_error(f"取得失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _update_category_list(self, categories):
        self.category_listbox.delete(0, tk.END)
        for cat in sorted(categories):
            self.category_listbox.insert(tk.END, cat)
        self._set_status(f"カテゴリ数: {len(categories)}")

    def _on_category_select(self, event):
        sel = self.category_listbox.curselection()
        if not sel:
            return
        self.current_category = self.category_listbox.get(sel[0])
        self.category_label.config(text=f"カテゴリ: {self.current_category}")
        self._refresh_tracks()

    def _refresh_tracks(self):
        """選択中カテゴリの曲リストを更新"""
        if not self.current_category:
            return
        cat = self.current_category
        self._set_status(f"{cat} の曲リストを取得中...")

        def task():
            try:
                files = self.vps.list_files(cat)
                meta = self.vps.get_meta(cat)
                meta_map = {m.get("file"): m for m in meta} if isinstance(meta, list) else {}

                tracks = []
                for f in files:
                    m = meta_map.get(f["name"], {})
                    tracks.append(
                        {
                            "file": f["name"],
                            "name": m.get("name", f["name"]),
                            "duration": m.get("duration", 0),
                            "size": f["size"],
                            "path": f["path"],
                        }
                    )

                tracks.sort(key=lambda t: t["name"].lower())
                self.tracks_data = tracks
                self.after(0, self._update_track_list)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"取得失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _update_track_list(self):
        self.track_tree.delete(*self.track_tree.get_children())
        for t in self.tracks_data:
            self.track_tree.insert(
                "",
                tk.END,
                values=(
                    t["file"],
                    t["name"],
                    format_duration(t["duration"]),
                    format_size(t["size"]),
                ),
            )
        count = len(self.tracks_data)
        total_size = sum(t["size"] for t in self.tracks_data)
        self._set_status(f"{count} 曲 / 合計 {format_size(total_size)}")

    def _add_category(self):
        name = simpledialog.askstring("カテゴリ追加", "新しいカテゴリ名:")
        if not name:
            return
        name = name.strip()
        if not name:
            return

        def task():
            try:
                self.vps.create_category(name)
                self.after(0, self._refresh_categories)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"作成失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _rename_category(self):
        sel = self.category_listbox.curselection()
        if not sel:
            messagebox.showinfo("情報", "カテゴリを選択してください。")
            return
        old = self.category_listbox.get(sel[0])
        new = simpledialog.askstring("カテゴリリネーム", "新しい名前:", initialvalue=old)
        if not new or new == old:
            return

        def task():
            try:
                self.vps.rename_category(old, new)
                self.current_category = new
                self.after(0, self._refresh_categories)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"リネーム失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _delete_category(self):
        sel = self.category_listbox.curselection()
        if not sel:
            messagebox.showinfo("情報", "カテゴリを選択してください。")
            return
        name = self.category_listbox.get(sel[0])

        def task():
            try:
                deleted = self.vps.delete_category(name)
                if deleted:
                    self.current_category = None
                    self.category_label.config(text="カテゴリ: （未選択）")
                    self.tracks_data = []
                    self.after(0, self._update_track_list)
                    self.after(0, self._refresh_categories)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"削除失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _upload_files(self):
        if not self.current_category:
            messagebox.showinfo("情報", "先にカテゴリを選択してください。")
            return
        files = filedialog.askopenfilenames(
            title="音楽ファイルを選択",
            filetypes=[
                ("音声ファイル", "*.mp3 *.ogg *.wav *.m4a *.flac"),
                ("すべてのファイル", "*.*"),
            ],
        )
        if files:
            self._upload_files_async(files)

    def _upload_files_async(self, files):
        """ファイルを非同期アップロード"""
        cat = self.current_category
        total = len(files)

        # プログレスウィンドウ
        prog_win = tk.Toplevel(self)
        prog_win.title("アップロード中")
        prog_win.geometry("400x120")
        prog_win.transient(self)
        prog_win.grab_set()

        prog_label = ttk.Label(prog_win, text=f"0 / {total} アップロード中...")
        prog_label.pack(pady=10)
        prog_bar = ttk.Progressbar(prog_win, maximum=total, mode="determinate")
        prog_bar.pack(fill=tk.X, padx=20, pady=5)
        detail_label = ttk.Label(prog_win, text="", font=("", 9))
        detail_label.pack(pady=5)

        def task():
            meta = self.vps.get_meta(cat)
            if not isinstance(meta, list):
                meta = []
            existing_files = {m.get("file") for m in meta}

            for i, file_path in enumerate(files):
                filename = os.path.basename(file_path)

                # 重複チェック
                if filename in existing_files:
                    self.after(0, lambda fn=filename: detail_label.config(text=f"スキップ（既存）: {fn}"))
                    prog_bar.step()
                    continue

                self.after(0, lambda fn=filename, idx=i: prog_label.config(text=f"{idx + 1} / {total} アップロード中..."))
                self.after(0, lambda fn=filename: detail_label.config(text=fn))

                try:
                    self.vps.upload_file(file_path, cat)

                    # 再生時間取得
                    duration = get_audio_duration(file_path)

                    # 表示名を生成（拡張子なし）
                    display_name = os.path.splitext(filename)[0]

                    meta.append(
                        {"file": filename, "name": display_name, "duration": duration}
                    )

                except Exception as e:
                    self.after(0, lambda err=e: detail_label.config(text=f"エラー: {err}"))

                self.after(0, lambda: prog_bar.step())

            # meta.jsonを保存
            try:
                self.vps.save_meta(cat, meta)
            except Exception as e:
                self.after(0, lambda err=e: messagebox.showwarning("警告", f"meta.jsonの保存に失敗: {err}"))

            self.after(0, lambda: prog_win.destroy())
            self.after(0, self._refresh_tracks)

        threading.Thread(target=task, daemon=True).start()

    def _delete_tracks(self):
        selected = self.track_tree.selection()
        if not selected:
            return
        items = [self.track_tree.item(s, "values") for s in selected]
        names = [item[0] for item in items]
        if not messagebox.askyesno("確認", f"{len(names)}曲を削除しますか？\n" + "\n".join(names[:5]) + ("..." if len(names) > 5 else "")):
            return

        cat = self.current_category
        paths_to_delete = []
        for s in selected:
            values = self.track_tree.item(s, "values")
            filename = values[0]
            paths_to_delete.append((filename, f"{REMOTE_BASE}/{cat}/{filename}"))

        def task():
            try:
                for filename, path in paths_to_delete:
                    self.vps.delete_file(path)

                # meta.jsonからも削除
                meta = self.vps.get_meta(cat)
                if isinstance(meta, list):
                    deleted_files = {f for f, _ in paths_to_delete}
                    meta = [m for m in meta if m.get("file") not in deleted_files]
                    self.vps.save_meta(cat, meta)

                self.after(0, self._refresh_tracks)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"削除失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _edit_meta_name(self):
        selected = self.track_tree.selection()
        if not selected:
            messagebox.showinfo("情報", "曲を選択してください。")
            return
        if len(selected) > 1:
            messagebox.showinfo("情報", "1曲だけ選択してください。")
            return

        values = self.track_tree.item(selected[0], "values")
        filename = values[0]
        current_name = values[1]

        new_name = simpledialog.askstring(
            "表示名編集", f"「{filename}」の表示名:", initialvalue=current_name
        )
        if not new_name or new_name == current_name:
            return

        cat = self.current_category

        def task():
            try:
                meta = self.vps.get_meta(cat)
                if not isinstance(meta, list):
                    meta = []

                # 既存エントリを探す、なければ追加
                found = False
                for m in meta:
                    if m.get("file") == filename:
                        m["name"] = new_name
                        found = True
                        break
                if not found:
                    meta.append({"file": filename, "name": new_name, "duration": 0})

                self.vps.save_meta(cat, meta)
                self.after(0, self._refresh_tracks)
            except Exception as e:
                self.after(0, lambda: self._show_error(f"編集失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _download_file(self):
        selected = self.track_tree.selection()
        if not selected:
            return
        if len(selected) > 1:
            messagebox.showinfo("情報", "1曲だけ選択してください。")
            return

        values = self.track_tree.item(selected[0], "values")
        filename = values[0]

        save_path = filedialog.asksaveasfilename(
            title="保存先",
            initialfile=filename,
            filetypes=[("音声ファイル", "*.*")],
        )
        if not save_path:
            return

        cat = self.current_category
        remote_path = f"{REMOTE_BASE}/{cat}/{filename}"
        self._set_status(f"ダウンロード中: {filename}...")

        def task():
            try:
                self.vps.download_file(remote_path, save_path)
                self.after(0, lambda: self._set_status(f"ダウンロード完了: {filename}"))
                self.after(0, lambda: messagebox.showinfo("完了", f"保存しました:\n{save_path}"))
            except Exception as e:
                self.after(0, lambda: self._show_error(f"ダウンロード失敗: {e}"))

        threading.Thread(target=task, daemon=True).start()

    def _show_context_menu(self, event):
        item = self.track_tree.identify_row(event.y)
        if item:
            if item not in self.track_tree.selection():
                self.track_tree.selection_set(item)
            self.context_menu.tk_popup(event.x_root, event.y_root)

    def _show_error(self, msg):
        self._set_status("エラー")
        messagebox.showerror("エラー", msg)


def main():
    # SSH鍵のパスを環境変数で上書き可能に
    global SSH_KEY
    if os.environ.get("UDONARIUM_SSH_KEY"):
        SSH_KEY = os.environ["UDONARIUM_SSH_KEY"]

    if not os.path.exists(SSH_KEY):
        print(f"⚠️ SSH鍵が見つかりません: {SSH_KEY}")
        print("環境変数 UDONARIUM_SSH_KEY でパスを指定できます。")
        sys.exit(1)

    app = MusicLibraryManager()
    app.mainloop()


if __name__ == "__main__":
    main()
