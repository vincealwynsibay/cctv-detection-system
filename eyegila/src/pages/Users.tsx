import { useState } from 'react';
import { toast } from 'sonner';
import { usersApi } from '@/services/users';
import type { User } from '@/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Users as UsersIcon, Plus, KeyRound, Trash2, Loader2, ShieldAlert } from 'lucide-react';

export function UsersPage() {
  const [adminKey, setAdminKey] = useState('');
  const [authed, setAuthed] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      const list = await usersApi.list(adminKey);
      setUsers(list);
      setAuthed(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Invalid admin key');
    } finally {
      setConnecting(false);
    }
  }

  async function load() {
    try { setUsers(await usersApi.list(adminKey)); } catch { /* ignore */ }
  }

  function openCreate() { setEditing(null); setUsername(''); setPassword(''); setShowModal(true); }
  function openEdit(u: User) { setEditing(u); setUsername(u.username); setPassword(''); setShowModal(true); }

  async function save() {
    if (!username || !password) return;
    setSaving(true);
    try {
      if (editing) {
        await usersApi.update(editing.id, { password }, adminKey);
        toast.success('Password updated');
      } else {
        await usersApi.create({ username, password }, adminKey);
        toast.success('User created');
      }
      setShowModal(false);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(u: User) {
    try { await usersApi.delete(u.id, adminKey); toast.success('Deleted'); load(); }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Delete failed'); }
  }

  if (!authed) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight">Users</h1>
        <Card className="max-w-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Admin Access Required</CardTitle>
            </div>
            <CardDescription>
              User management requires the <code>SUPER_KEY</code> configured on the server -
              separate from your login session.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-key">Admin Key</Label>
              <Input
                id="admin-key"
                name="admin-key"
                type="password"
                value={adminKey}
                onChange={e => setAdminKey(e.target.value)}
                placeholder="SUPER_KEY value…"
                autoComplete="current-password"
                onKeyDown={e => e.key === 'Enter' && connect()}
              />
            </div>
            <Button onClick={connect} disabled={connecting || !adminKey}>
              {connecting && <Loader2 data-icon="inline-start" className="animate-spin" />}
              Connect
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground mt-0.5 print:hidden">
            Manage operator accounts and reset passwords.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus data-icon="inline-start" />
          Add User
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <UsersIcon className="size-10 opacity-30" />
              <p className="text-sm">No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">ID</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(u => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">#{u.id}</TableCell>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(u.time).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openEdit(u)}>
                          <KeyRound className="size-3 mr-1" />
                          Reset
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" aria-label={`Delete ${u.username}`}>
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {u.username}?</AlertDialogTitle>
                              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => deleteUser(u)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Reset Password -${editing.username}` : 'Add User'}</DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex flex-col gap-4 py-2">
            {!editing && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-username">Username</Label>
                <Input id="user-username" name="username" autoComplete="username" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} autoFocus />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-password">{editing ? 'New Password' : 'Password'}</Label>
              <Input id="user-password" name="password" type="password" autoComplete={editing ? 'new-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !username || !password}>
              {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
