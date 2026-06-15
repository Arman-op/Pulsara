import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { Button } from '../../shared/components/Button';
import { Input } from '../../shared/components/Input';
import { User, Bell, Link as LinkIcon, Shield } from 'lucide-react';
import { useAuthStore } from '../../shared/store/authStore';
export default function Settings() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = React.useState('account');
  const tabs = [
    { id: 'account', label: 'Account Profile', icon: User },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'integrations', label: 'Integrations', icon: LinkIcon },
  ];
  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-white">Settings</h1>
      </div>
      <div className="flex flex-col md:flex-row gap-8">
        {/* Sidebar */}
        <aside className="w-full md:w-64 flex-shrink-0">
          <nav className="flex flex-col space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted hover:bg-surface hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </aside>
        {/* Content */}
        <main className="flex-1 space-y-6">
          {activeTab === 'account' && (
            <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Account Information</CardTitle>
                <p className="text-sm text-muted mt-1">Update your personal information and email address.</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 flex flex-col items-start gap-4">
                  <div className="w-20 h-20 rounded-full bg-surface border border-border flex items-center justify-center text-2xl font-bold text-accent">
                    {user?.name?.charAt(0) || 'U'}
                  </div>
                  <Button variant="outline" size="sm">Change Avatar</Button>
                </div>
                <div className="grid gap-4 md:grid-cols-2 pt-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Full Name</label>
                    <Input defaultValue={user?.name} className="max-w-md" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Email Address</label>
                    <Input defaultValue={user?.email} type="email" className="max-w-md" />
                  </div>
                  <div className="space-y-2 mt-4 md:col-span-2">
                    <label className="text-sm font-medium text-white">Role</label>
                    <Input defaultValue={user?.role} disabled className="max-w-md text-muted" />
                    <p className="text-xs text-muted mt-1">To change your role, contact an administrator.</p>
                  </div>
                </div>
                <div className="pt-6">
                  <Button>Save Changes</Button>
                </div>
              </CardContent>
            </Card>
          )}
          {activeTab === 'security' && (
            <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Security & Password</CardTitle>
                <p className="text-sm text-muted mt-1">Manage your password and security settings.</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-4 max-w-sm">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Current Password</label>
                    <Input type="password" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">New Password</label>
                    <Input type="password" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Confirm Password</label>
                    <Input type="password" />
                  </div>
                </div>
                <div className="pt-6">
                  <Button variant="danger">Update Password</Button>
                </div>
              </CardContent>
            </Card>
          )}
          {activeTab === 'notifications' && (
            <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Notification Preferences</CardTitle>
                <p className="text-sm text-muted mt-1">Choose what you want to be notified about.</p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <div>
                    <h4 className="text-white font-medium text-sm">Deployment Alerts</h4>
                    <p className="text-muted text-xs mt-0.5">Receive notifications when deployments fail.</p>
                  </div>
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent" />
                </div>
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <div>
                    <h4 className="text-white font-medium text-sm">System Incidents</h4>
                    <p className="text-muted text-xs mt-0.5">Alerts about critical system downtime.</p>
                  </div>
                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent" />
                </div>
                <div className="flex items-center justify-between py-2">
                  <div>
                    <h4 className="text-white font-medium text-sm">Weekly Report</h4>
                    <p className="text-muted text-xs mt-0.5">Summary of system health and metrics.</p>
                  </div>
                  <input type="checkbox" className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent" />
                </div>
              </CardContent>
            </Card>
          )}
          {activeTab === 'integrations' && (
            <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Connected Integrations</CardTitle>
                <p className="text-sm text-muted mt-1">Connect your workspace with third-party tools.</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-surface border border-border">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-[#E34F26]/10 text-[#E34F26] rounded-md flex items-center justify-center">
                      <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.022A9.606 9.606 0 0112 6.82c.85.004 1.705.114 2.504.336 1.909-1.29 2.747-1.022 2.747-1.022.546 1.379.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-white font-medium text-sm">GitHub</h4>
                      <p className="text-muted text-xs mt-0.5">Connected to repository parsing.</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm">Configure</Button>
                </div>
                <div className="flex items-center justify-between p-4 rounded-lg bg-surface border border-border">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-[#E01E5A]/10 text-[#E01E5A] rounded-md flex items-center justify-center">
                       <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522v-2.521zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.523-2.522v-2.522h2.523zM15.165 17.688a2.527 2.527 0 0 1-2.523-2.523 2.526 2.526 0 0 1 2.523-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-white font-medium text-sm">Slack</h4>
                      <p className="text-muted text-xs mt-0.5">Not connected.</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm">Connect</Button>
                </div>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}