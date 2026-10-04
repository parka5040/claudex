import { atom, read } from 'claude-code'
import type { On } from 'claude-code'
import { pollCurrent } from './jobs.ts'

const paneJobs = atom({ plugin: 'claudex', key: 'jobs' } as const, [])
const paneReport = atom({ plugin: 'claudex', key: 'report' } as const, null)
import { cancelRequest, resultRequest } from './worker.ts'

export const WORKERS_PANE = 'claudex-workers'

export function registerWorkersPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: WORKERS_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const jobs = await read($, paneJobs)
    const report = await read($, paneReport)
    const width = Math.max(16, e.props.bodyColumns)
    const fit = (text: string) => text.length <= width ? text : `${text.slice(0, width - 3)}...`

    return (
      <Box flexDirection="column">
        {jobs.length === 0 && <Text dimColor>No workers yet.</Text>}
        {jobs.slice(0, 20).map(job => (
          <Box key={job.id} flexDirection="column">
            <Text>{fit(`${job.tier ?? '?'} ${job.model ?? '?'} ${job.mode ?? '?'} ${job.state} ${job.elapsed_s === null ? '?' : `${job.elapsed_s}s`} ${job.cwd?.split('/').filter(Boolean).at(-1) ?? '?'} ${job.origin ?? '?'}`)}</Text>
            {job.state === 'running' ? (
              <Button key={`cancel-${job.id}`} label="Cancel" onPress={async () => {
                const request = cancelRequest($.plugin.root, job.id)
                const result = await $.process.run(request.argv, request.init)
                if (result.exitCode !== 0) $.ui.toast(result.stderr || `claudex: cancel ${job.id} failed`)
                await pollCurrent()
              }} />
            ) : (
              <Button key={`report-${job.id}`} label="Report" onPress={async () => {
                const request = resultRequest($.plugin.root, job.id)
                const result = await $.process.run(request.argv, request.init)
                await $.state.set({ plugin: 'claudex', key: 'report' } as const,
                  { job: job.id, text: result.stdout || result.stderr })
              }} />
            )}
          </Box>
        ))}
        {report && <Box flexDirection="column">
          <Text bold>Report {report.job}</Text>
          <Markdown text={report.text.slice(0, 9500).replace(/[^\P{Cc}\t\n]/gu, '') + (report.text.length > 9500 ? '\n\n[Report shortened; use claudex-worker result JOB for the full report.]' : '')} />
        </Box>}
        <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: WORKERS_PANE })} />
      </Box>
    )
  })
}
